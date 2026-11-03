import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError } from '../common/domain-error';

// Cloudflare Turnstile on POST /auth/login. Off until both TURNSTILE_SITE_KEY
// and TURNSTILE_SECRET_KEY are set (hotel.env on the NAS). When on:
//
//  - GET /auth/config hands the browser the site key (never the secret), so
//    the key is read at run time and changing it needs no web rebuild.
//  - Login needs `turnstileToken` in its JSON body. The token is checked with
//    siteverify BEFORE the email is counted as an attempt or the password is
//    looked at: a failed captcha says nothing about the email and cannot fill
//    the per-email attempt window, so nobody can lock an account through it.
//  - Every doubt fails closed: missing or malformed token, success false, a
//    token for another action (an empty action only with a Cloudflare dummy
//    site key) or (with TURNSTILE_HOSTNAMES) another hostname
//    is 403 captcha_failed; siteverify unreachable, slow (5 s), non-200 or
//    not JSON is 503 captcha_unavailable.
//  - The secret and the token never reach a log line or an error message.

export const TURNSTILE_CONFIG = Symbol('TURNSTILE_CONFIG');
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const SITEVERIFY_TIMEOUT_MS = 5000;
/** The action the sign-in widget is rendered with (apps/hotel-web, /prijava). */
export const LOGIN_ACTION = 'login';
/** Cloudflare's documented maximum token length. */
const TOKEN_MAX = 2048;

export interface TurnstileConfig {
  siteKey: string;
  secretKey: string;
  /** Always SITEVERIFY_URL outside tests; there is deliberately no environment variable for it. */
  verifyUrl: string;
  timeoutMs: number;
  /** Hostnames a token may be solved on (TURNSTILE_HOSTNAMES); null skips the check. */
  hostnames: string[] | null;
}

/**
 * Reads TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY and TURNSTILE_HOSTNAMES.
 * Both keys: on. Neither: off, silently. Only one: off, and `log` gets one
 * line naming the missing variable (never a value), so a half-done setup is
 * visible in `docker logs hotel-api-claude` without blocking sign-in.
 */
export function loadTurnstileConfig(
  env: Record<string, string | undefined>,
  log: (line: string) => void,
): TurnstileConfig | null {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() ?? '';
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim() ?? '';
  if (siteKey === '' && secretKey === '') return null;
  if (siteKey === '' || secretKey === '') {
    const missing = siteKey === '' ? 'TURNSTILE_SITE_KEY' : 'TURNSTILE_SECRET_KEY';
    log(`Turnstile je isključen: nedostaje ${missing} (potrebna su oba ključa).`);
    return null;
  }
  const hostnames = (env.TURNSTILE_HOSTNAMES ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '');
  return {
    siteKey,
    secretKey,
    verifyUrl: SITEVERIFY_URL,
    timeoutMs: SITEVERIFY_TIMEOUT_MS,
    hostnames: hostnames.length > 0 ? hostnames : null,
  };
}

/** Cloudflare's published test site keys (1x… always passes, 2x… always blocks, 3x… forces a challenge). */
export function isDummySiteKey(siteKey: string): boolean {
  return /^[123]x0{20}AA$/.test(siteKey);
}

function captchaFailed(): DomainError {
  return new DomainError('captcha_failed', 'Provera da niste robot nije prošla. Pokušajte ponovo.', 403);
}

function captchaUnavailable(): DomainError {
  return new DomainError(
    'captcha_unavailable',
    'Provera da niste robot trenutno nije dostupna. Pokušajte ponovo za minut.',
    503,
  );
}

@Injectable()
export class TurnstileService {
  private readonly logger = new Logger('Turnstile');

  constructor(@Inject(TURNSTILE_CONFIG) private readonly config: TurnstileConfig | null) {}

  /** The public site key for GET /auth/config, or null while Turnstile is off. */
  siteKey(): string | null {
    return this.config?.siteKey ?? null;
  }

  /**
   * Throws captcha_failed / captcha_unavailable unless `token` passes
   * siteverify. Does nothing while Turnstile is off.
   *
   * No `remoteip` is sent (it is optional). Express's req.ip trusts
   * X-Forwarded-For from every private address (TRUSTED_PROXIES, src/http.ts),
   * which includes any LAN client of :4200, so the address would be whatever
   * the caller claims.
   */
  async verify(token: unknown): Promise<void> {
    const config = this.config;
    if (!config) return;
    if (typeof token !== 'string' || token === '' || token.length > TOKEN_MAX) throw captchaFailed();

    const body: Record<string, string> = {
      secret: config.secretKey,
      response: token,
      // Lets Cloudflare recognise a repeated call; we never retry, so it only
      // marks this one verification.
      idempotency_key: randomUUID(),
    };

    let answer: Record<string, unknown>;
    try {
      const res = await fetch(config.verifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (res.status !== 200) {
        this.logger.warn(`siteverify je odgovorio statusom ${res.status}; prijava odbijena (503).`);
        throw captchaUnavailable();
      }
      const parsed: unknown = await res.json().catch(() => null);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        this.logger.warn('siteverify nije vratio JSON; prijava odbijena (503).');
        throw captchaUnavailable();
      }
      answer = parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof DomainError) throw err;
      // Name only: a fetch error message could carry the URL, never the body.
      const why = (err as Error)?.name === 'TimeoutError' ? 'nije odgovorio na vreme' : 'nije dostupan';
      this.logger.warn(`siteverify ${why}; prijava odbijena (503).`);
      throw captchaUnavailable();
    }

    if (answer.success !== true) throw captchaFailed();
    // A real token from our widget always carries LOGIN_ACTION. Cloudflare's
    // dummy keys answer with an empty action, so only with a dummy site key
    // is an empty action accepted.
    const action = typeof answer.action === 'string' ? answer.action : '';
    if (action !== LOGIN_ACTION && !(action === '' && isDummySiteKey(config.siteKey))) throw captchaFailed();
    if (config.hostnames) {
      const hostname = typeof answer.hostname === 'string' ? answer.hostname.toLowerCase() : '';
      if (!config.hostnames.includes(hostname)) throw captchaFailed();
    }
  }
}
