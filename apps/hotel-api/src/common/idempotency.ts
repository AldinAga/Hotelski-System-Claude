import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/tokens';
import { validationFailed, type Body } from './input';

// Request keys of the money routes (folio charges, corrections, payments,
// refunds, voids; documents from Task 8). The client sends a fresh key per
// intent and repeats it on a retry; the server stores it with a hash of what
// was asked, so a retry gets the first result back (200) and a different
// request under the same key is refused (409 idempotency_key_reused).
// The uniqueness itself lives in the database (spec 5.5, constraints).

const KEY = /^[A-Za-z0-9_-]{8,100}$/;

/** The body's `key`: 8-100 of A-Z, a-z, 0-9, _ and -; otherwise 422 validation_failed { field: 'key' }. */
export function parseKey(body: Body): string {
  const key = body.key;
  if (typeof key !== 'string' || !KEY.test(key)) throw validationFailed('key');
  return key;
}

/** JSON with object keys sorted at every level, so equal requests hash equally. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/**
 * SHA-256 (hex) of the canonical JSON of { route, subject, fields }: `route`
 * names the operation ('folio.pay'), `subject` the stay, line or payment it
 * acts on, `fields` the parsed request without the key. Callers pass parsed,
 * normalised values, so a retry that differs only in spelling (an absent
 * optional field versus null) hashes the same.
 */
export function requestHash(route: string, subject: string, fields: Record<string, unknown>): string {
  return createHash('sha256').update(canonical({ route, subject, fields })).digest('hex');
}

/** Namespace (first key) of the request-key advisory locks; own value, apart from the other 7_301_00x locks. */
export const REQUEST_KEY_LOCK_NS = 7_301_010;

/** The tables that hold request keys, each unique per property. */
export type KeySource = 'folio_line' | 'payment' | 'folio_document';

/**
 * Where a request key of the property was used: one lookup across every table
 * that holds keys (preflight F6), so a key is never replayed into another kind
 * of write. null when the key is new.
 *
 * Takes a transaction advisory lock on (property, key) first. Uniqueness holds
 * per table, so without it a payment on one folio and a document on another with
 * the same key both commit, and a later lookup finds two matches. With it the
 * second request waits for the first to commit and then sees its row (READ
 * COMMITTED: each statement has its own snapshot).
 *
 * Lock order (constraints.md): this is the LAST lock of every caller, after the
 * business day (0), counter (5) and folio (6) rows. Nothing takes a lock after
 * it (only inserts follow), so a holder never waits for anything and the lock
 * cannot be part of a cycle. Its namespace is its own (REQUEST_KEY_LOCK_NS).
 */
export async function findKey(
  tx: Tx,
  propertyId: string,
  key: string,
): Promise<{ source: KeySource; id: string; request_hash: string } | null> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${REQUEST_KEY_LOCK_NS}::int, hashtext(${`${propertyId}:${key}`}))`);
  const { rows } = await tx.execute<{ source: KeySource; id: string; request_hash: string }>(sql`
    SELECT 'folio_line' AS source, id, request_hash FROM folio_line
     WHERE property_id = ${propertyId} AND idempotency_key = ${key}
    UNION ALL
    SELECT 'payment' AS source, id, request_hash FROM payment
     WHERE property_id = ${propertyId} AND idempotency_key = ${key}
    UNION ALL
    SELECT 'folio_document' AS source, id, request_hash FROM folio_document
     WHERE property_id = ${propertyId} AND idempotency_key = ${key}`);
  return rows[0] ?? null;
}
