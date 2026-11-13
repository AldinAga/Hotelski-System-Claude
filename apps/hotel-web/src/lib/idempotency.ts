'use client';

import { useRef } from 'react';

/**
 * Request keys of the money routes (hotel-api, common/idempotency.ts): one
 * fresh key per intent, repeated unchanged on a retry, so the server answers
 * a repeated request with the first result instead of doing it twice.
 * 36 characters of 0-9, a-f and "-" are inside the API's 8-100 limit.
 */
export function newKey(): string {
  // randomUUID exists only in secure contexts (HTTPS, localhost); the staging
  // reception is plain HTTP on the LAN. getRandomValues works everywhere.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
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
