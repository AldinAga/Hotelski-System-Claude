import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { newKey, useIdempotencyKey } from './idempotency';

/** The API accepts 8-100 of A-Z, a-z, 0-9, _ and - (hotel-api common/idempotency.ts). */
const API_KEY = /^[A-Za-z0-9_-]{8,100}$/;

describe('newKey', () => {
  it('makes a key the API accepts, and a different one every time', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newKey()));
    expect(keys.size).toBe(50);
    for (const key of keys) expect(key).toMatch(API_KEY);
  });
});

describe('useIdempotencyKey', () => {
  it('newKey does not change between repeated attempts of the same dialog, even across renders', () => {
    const { result, rerender } = renderHook(() => useIdempotencyKey());
    const first = result.current.key();
    // A second click, then a retry after a network error: the same intent, the same key.
    expect(result.current.key()).toBe(first);
    rerender();
    expect(result.current.key()).toBe(first);
  });

  it('renew gives the next intent a new key', () => {
    const { result } = renderHook(() => useIdempotencyKey());
    const first = result.current.key();
    result.current.renew();
    const second = result.current.key();
    expect(second).not.toBe(first);
    expect(second).toMatch(API_KEY);
    expect(result.current.key()).toBe(second);
  });

  it('two dialogs do not share a key', () => {
    const a = renderHook(() => useIdempotencyKey());
    const b = renderHook(() => useIdempotencyKey());
    expect(a.result.current.key()).not.toBe(b.result.current.key());
  });
});
