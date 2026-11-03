'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { EntryPortal } from '@/components/entry-portal';
import { api, ApiError, checkSetup, navigation, send } from '@/lib/api';
import { MESSAGES, messageFor } from '@/lib/messages';
import { loadTurnstile, TURNSTILE_LOGIN_ACTION, type TurnstileApi } from '@/lib/turnstile';

interface AuthConfig {
  turnstileSiteKey: string | null;
}

/** The site key from GET /auth/config, or null when Turnstile is off or the call failed. */
async function fetchSiteKey(): Promise<string | null> {
  try {
    const c = await api<AuthConfig>('/auth/config');
    return typeof c?.turnstileSiteKey === 'string' && c.turnstileSiteKey !== '' ? c.turnstileSiteKey : null;
  } catch {
    return null;
  }
}

/**
 * "flexible" needs at least 300 px; below a 365 px viewport the card (16 px
 * gutters plus its padding) is narrower than that, so the widget goes compact.
 */
function widgetSize(): 'flexible' | 'compact' {
  const narrow = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 364px)').matches;
  return narrow ? 'compact' : 'flexible';
}

/**
 * Email and password; owners and managers also need the current code from
 * their authenticator. The code field appears once the API answers
 * totp_required (or totp_invalid), so receptionists never see it.
 *
 * Cloudflare Turnstile appears only when GET /auth/config returns a site key
 * (hotel-api decides, src/auth/turnstile.ts). Its token goes with the login
 * and is single-use, so the widget is reset after every failed attempt.
 */
export default function SignInPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const widgetBox = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null);

  useEffect(() => {
    // An installation still in first-run setup has nobody to sign in yet;
    // checkSetup sends the browser to /aktivacija in that case.
    checkSetup().catch(() => undefined);
    let live = true;
    // Without an answer the page works as it did before Turnstile: if the API
    // does want a token, the login answers captcha_failed and says so.
    void fetchSiteKey().then((key) => {
      if (live && key) setSiteKey(key);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!siteKey) return;
    let live = true;
    loadTurnstile()
      .then((turnstile) => {
        const box = widgetBox.current;
        if (!live || !box) return;
        const id = turnstile.render(box, {
          sitekey: siteKey,
          action: TURNSTILE_LOGIN_ACTION,
          theme: 'auto',
          size: widgetSize(),
          callback: (token) => setCaptchaToken(token),
          'expired-callback': () => setCaptchaToken(null),
          'timeout-callback': () => setCaptchaToken(null),
          'error-callback': () => setCaptchaToken(null),
        });
        if (id !== undefined) widget.current = { api: turnstile, id };
      })
      .catch(() => {
        if (live) setError(MESSAGES.captcha_load_failed);
      });
    return () => {
      live = false;
      if (widget.current) {
        widget.current.api.remove(widget.current.id);
        widget.current = null;
      }
    };
  }, [siteKey]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (siteKey && !captchaToken) {
      setError(MESSAGES.captcha_pending);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = { email: email.trim(), password };
      if (needsCode) body.totp = totp.replace(/\s/g, '');
      if (siteKey && captchaToken) body.turnstileToken = captchaToken;
      await api('/auth/login', send('POST', body));
      navigation.go('/');
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'totp_required' || err.code === 'totp_invalid')) {
        setNeedsCode(true);
        setTotp('');
      }
      if (siteKey) {
        // The token was spent on this attempt; the next one needs a fresh check.
        setCaptchaToken(null);
        if (widget.current) widget.current.api.reset(widget.current.id);
      } else if (err instanceof ApiError && err.code === 'captcha_failed') {
        // The API wants a token but the page has no widget (the config call
        // failed earlier): ask again rather than let the person retry blindly.
        const key = await fetchSiteKey();
        if (key) setSiteKey(key);
        else {
          setError(MESSAGES.captcha_reload);
          return;
        }
      }
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <EntryPortal title="Prijava" lead="Prijavite se nalogom recepcije.">
      <form className="card stack" onSubmit={onSubmit}>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <label>
          E-adresa
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Lozinka
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {needsCode && (
          <>
            <label>
              Kod iz aplikacije
              <input
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
              />
            </label>
            <p className="help">Šestocifreni kod iz aplikacije za autentifikaciju; menja se na 30 sekundi.</p>
          </>
        )}
        {siteKey && <div ref={widgetBox} className="portal-turnstile" data-testid="turnstile" />}
        <button type="submit" disabled={busy}>
          Prijavi se
        </button>
      </form>
    </EntryPortal>
  );
}
