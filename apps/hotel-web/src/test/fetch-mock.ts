import { vi } from 'vitest';

export interface Call {
  method: string;
  /** Path with query, as the page requested it (e.g. /api/units). */
  url: string;
  body: unknown;
}

export interface Reply {
  status?: number;
  body?: unknown;
}

/** A function route may answer later (a Promise), to stage out-of-order responses. */
type Route = Reply | ((call: Call) => Reply | Promise<Reply>);

/**
 * Replaces global fetch. Routes are keyed "METHOD /api/path" (query ignored);
 * an unknown route answers 599 so a page calling something unexpected shows
 * up as an error instead of passing quietly. Returns the recorded calls.
 */
export function mockFetch(routes: Record<string, Route>): Call[] {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const call = { method, url, body };
    calls.push(call);
    const route = routes[`${method} ${url.split('?')[0]}`];
    const reply: Reply = route === undefined
      ? { status: 599, body: { code: 'unmocked', message: `unmocked ${method} ${url}`, details: null } }
      : typeof route === 'function'
        ? await route(call)
        : route;
    const status = reply.status ?? 200;
    const text = reply.body === undefined ? null : JSON.stringify(reply.body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

export function apiError(status: number, code: string, message = 'poruka servera', details: unknown = null): Reply {
  return { status, body: { code, message, details } };
}
