import type { NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

// HTTP hardening shared by main.ts and the test app (test/app.ts), so the
// tests exercise exactly what runs.
//
// Cross-site request forgery. The session cookie is SameSite=Strict, but
// SameSite does not look at ports: every app on the same host (Admin Panel,
// POS, Portainer, later hotel-hub on 192.168.1.199) is the "same site", so a
// page there could post a form here and the browser would send hotel_session.
// Two independent checks close that:
//  1. Bodies are JSON only. Nest's default urlencoded parser is off and an
//     unsafe request with any other body type is 415. An HTML form cannot send
//     JSON, and a cross-origin fetch that sends JSON needs a CORS preflight,
//     which this API never grants.
//  2. An unsafe request (POST, PUT, PATCH, DELETE) whose Origin (or, without
//     Origin, Sec-Fetch-Site) shows another origin is 403 origin_refused.
//     Clients that send neither (scripts, tests, curl) are not browsers and
//     carry no ambient cookie, so they pass.

/** Nest application options: no default body parsers (configureHttp adds JSON only). */
export const HTTP_OPTIONS: NestApplicationOptions = { bodyParser: false };

/** Body size limit for JSON requests. */
export const JSON_LIMIT = '100kb';

/**
 * Proxies whose X-Forwarded-Proto is believed (Express `trust proxy`): the
 * front desk reaches the API through the Next rewrite in hotel-web, which
 * runs on the Docker network (a private address). A forged header from a
 * private address can only mark the caller's own cookie Secure.
 */
export const TRUSTED_PROXIES = 'loopback, linklocal, uniquelocal';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * HOTEL_WEB_ORIGIN: comma-separated exact origins allowed to send unsafe
 * requests (e.g. "https://recepcija.hotel.rs"). Unset or blank: null, which
 * means "the origin must be the host the request was sent to".
 */
export function parseAllowedOrigins(raw: string | undefined): string[] | null {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (list.length === 0) return null;
  return list.map((s) => {
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      throw new Error(`HOTEL_WEB_ORIGIN is not a list of origins (got "${s}")`);
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== s.replace(/\/+$/, '')) {
      throw new Error(`HOTEL_WEB_ORIGIN must hold origins like https://host[:port] (got "${s}")`);
    }
    return url.origin;
  });
}

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  const value = Array.isArray(v) ? v[0] : v;
  return value === undefined ? undefined : value;
}

/**
 * The host the browser addressed. Through the Next rewrite that is
 * X-Forwarded-Host (Next sets it to the browser's Host; a browser cannot set
 * it on a cross-origin form or simple request), otherwise Host.
 */
function addressedHost(req: Request): string | null {
  const forwarded = header(req, 'x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwarded || header(req, 'host')?.trim();
  return host ? host.toLowerCase() : null;
}

/** Why an unsafe request is refused as cross-origin, or null when it may pass. */
export function crossOriginReason(req: Request, allowed: string[] | null): string | null {
  const origin = header(req, 'origin');
  if (origin !== undefined) {
    if (origin === 'null') return 'opaque origin';
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return 'malformed origin';
    }
    if (allowed) return allowed.includes(url.origin) ? null : `origin ${url.origin} not allowed`;
    return url.host.toLowerCase() === addressedHost(req) ? null : `origin ${url.origin} is not this host`;
  }
  const site = header(req, 'sec-fetch-site');
  if (site === 'same-site' || site === 'cross-site') return `sec-fetch-site ${site}`;
  return null;
}

/** True when the request carries a body (chunked, or a non-zero Content-Length). */
function hasBody(req: Request): boolean {
  if (header(req, 'transfer-encoding') !== undefined) return true;
  const length = Number(header(req, 'content-length') ?? '0');
  return Number.isFinite(length) && length > 0;
}

function refuse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ code, message, details: null });
}

/** Express middleware: the two CSRF checks described at the top of this file. */
export function requestGuard(allowed: string[] | null) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!UNSAFE.has(req.method)) return next();
    if (crossOriginReason(req, allowed) !== null) {
      return refuse(
        res,
        403,
        'origin_refused',
        'Zahtev je poslat sa druge adrese i odbijen je. Otvorite recepciju direktno i pokušajte ponovo.',
      );
    }
    if (hasBody(req) && !req.is('application/json')) {
      return refuse(res, 415, 'unsupported_media_type', 'Zahtev mora biti poslat kao JSON.');
    }
    next();
  };
}

/** Wires trust proxy, the request guard and the JSON parser. Call before init/listen. */
export function configureHttp(app: NestExpressApplication, env: Record<string, string | undefined> = process.env): void {
  app.set('trust proxy', TRUSTED_PROXIES);
  app.use(requestGuard(parseAllowedOrigins(env.HOTEL_WEB_ORIGIN)));
  app.useBodyParser('json', { limit: JSON_LIMIT });
}
