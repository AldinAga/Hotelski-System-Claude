'use client';

import { useRef } from 'react';

/**
 * Request keys of the money routes (hotel-api, common/idempotency.ts): one
 * fresh key per intent, repeated unchanged on a retry, so the server answers
 * a repeated request with the first result instead of doing it twice.
 * 36 characters of 0-9, a-f and "-" are inside the API's 8-100 limit.
 */
export function newKey(): string {
  return crypto.randomUUID();
}

/**
 * The key of one open form or dialog: it is made on first use and stays the
 * same for every attempt (a second click, a retry after a network error)
 * until `renew()` is called, which the screen does when the intent is done
 * (the dialog closes, or the next, different payment starts).
 */
export function useIdempotencyKey(): { key: () => string; renew: () => void } {
  const ref = useRef<string | null>(null);
  return {
    key: () => (ref.current ??= newKey()),
    renew: () => {
      ref.current = null;
    },
  };
}
