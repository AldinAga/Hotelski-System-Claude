/**
 * Cloudflare Turnstile in the browser. The API decides whether it is on
 * (GET /auth/config returns a site key, src/auth/turnstile.ts in hotel-api);
 * only then does /prijava load Cloudflare's script, once per page, and render
 * the widget explicitly. Without a site key nothing here runs and no request
 * leaves for Cloudflare.
 */

export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
/** Must match LOGIN_ACTION in hotel-api: siteverify answers are checked against it. */
export const TURNSTILE_LOGIN_ACTION = 'login';

export interface TurnstileRenderOptions {
  sitekey: string;
  action?: string;
  theme?: 'auto' | 'light' | 'dark';
  size?: 'normal' | 'flexible' | 'compact';
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => boolean | void;
  'timeout-callback'?: () => void;
}

/** The part of window.turnstile this app uses. */
export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | undefined;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

function scriptTag(): HTMLScriptElement | null {
  return document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT_URL}"]`);
}

/** Adds Cloudflare's script once and resolves with window.turnstile when it has loaded. */
export function loadTurnstile(): Promise<TurnstileApi> {
  if (typeof window !== 'undefined' && window.turnstile) return Promise.resolve(window.turnstile);
  if (loading && scriptTag()) return loading;
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.addEventListener('load', () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error('turnstile missing after load'));
    });
    script.addEventListener('error', () => {
      // Lets a later attempt (a new visit to the page) add the script again.
      script.remove();
      loading = null;
      reject(new Error('turnstile script failed to load'));
    });
    document.head.appendChild(script);
  });
  return loading;
}

/** Tests only: forget the script and the pending load. */
export function resetTurnstileLoader(): void {
  scriptTag()?.remove();
  loading = null;
  if (typeof window !== 'undefined') delete window.turnstile;
}
