/**
 * The one way the browser talks to hotel-api: same origin under /api (see
 * next.config.ts), so the HttpOnly session cookie travels by itself.
 *
 * Every non-2xx answer becomes an ApiError carrying the API's
 * { code, message, details }. Show it with messageFor (src/lib/messages.ts).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Full-page navigation, behind an object so tests can replace it. */
export const navigation = {
  go(path: string): void {
    window.location.assign(path);
  },
};

export interface SetupStatus {
  activated: boolean;
  hasOwner: boolean;
  hasProperty: boolean;
}

const SIGN_IN = '/prijava';
const ACTIVATION = '/aktivacija';

function currentPath(): string {
  return typeof window === 'undefined' ? '' : window.location.pathname;
}

function goUnlessThere(path: string): void {
  if (currentPath() !== path) navigation.go(path);
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorFrom(status: number, body: unknown): ApiError {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const code = typeof b.code === 'string' ? b.code : `http_${status}`;
  const message = typeof b.message === 'string' ? b.message : '';
  const details =
    typeof b.details === 'object' && b.details !== null && !Array.isArray(b.details)
      ? (b.details as Record<string, unknown>)
      : null;
  return new ApiError(status, code, message, details);
}

/**
 * Calls `path` on hotel-api (e.g. "/units") and returns the parsed JSON body.
 *
 * - 401 sends the browser to /prijava, except for the sign-in call itself,
 *   whose 401 (invalid_credentials, totp_required) is an answer for the form.
 * - GET /setup/status answering 200 means first-run setup is still open (the
 *   API answers 410 once it is done), so the browser goes to /aktivacija.
 *   That covers activated: false and hasOwner: false, and also an owner whose
 *   first TOTP code is not confirmed yet: they cannot sign in either.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network_error', '', null);
  }
  const body = await readBody(res);

  if (!res.ok) {
    const err = errorFrom(res.status, body);
    if (res.status === 401 && !path.startsWith('/auth/login')) goUnlessThere(SIGN_IN);
    throw err;
  }
  if (path === '/setup/status') goUnlessThere(ACTIVATION);
  return body as T;
}

/** "open" while first-run setup runs (and redirects there), "done" on 410. */
export async function checkSetup(): Promise<'open' | 'done'> {
  try {
    await api<SetupStatus>('/setup/status');
    return 'open';
  } catch (err) {
    if (err instanceof ApiError && err.status === 410) return 'done';
    throw err;
  }
}

/** RequestInit for a JSON body. */
export function send(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown): RequestInit {
  return body === undefined ? { method } : { method, body: JSON.stringify(body) };
}
