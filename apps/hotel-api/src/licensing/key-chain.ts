import type { Logger } from '@nestjs/common';
import { acceptKeySet, type KeySet, type SignedKeySet } from '@platform/licensing';
import { ParentRefusal, ParentUnavailable, type CentralAdminClient } from './central-admin.client';

// The one place where key sets become trusted (SPEC 5.1). Activation, the
// periodic key refresh and the start-up replay all go through here.

/** Upper bound on `GET /v1/keys?since=` pages walked in one go. */
export const MAX_KEY_PAGES = 10;

type Log = Pick<Logger, 'warn' | 'error'>;

export type KeySetStep = { ok: true; keySet: KeySet } | { ok: false; reason: string };

/**
 * One step of the chain: `set` accepted against `trusted`. Never throws; the
 * SDK's TypeError for a corrupt trusted set becomes a refusal.
 */
export function acceptNext(set: unknown, trusted: KeySet): KeySetStep {
  try {
    const acceptance = acceptKeySet(set as SignedKeySet, trusted);
    return acceptance.ok ? { ok: true, keySet: acceptance.keySet } : { ok: false, reason: acceptance.reason };
  } catch (err) {
    return { ok: false, reason: (err as Error)?.message ?? 'error' };
  }
}

/**
 * Walks `GET /v1/keys?since=` from `start`, accepting sets strictly in order.
 * `stale_keyset` (authentic, nothing new) is skipped; any other refusal stops
 * the walk; so does a page that brings nothing new. A network failure or a
 * refusal by the Admin Panel ends the walk with what was accepted so far.
 */
export async function walkKeyChain(
  client: CentralAdminClient,
  start: KeySet,
  log: Log,
): Promise<{ trusted: KeySet; accepted: SignedKeySet[] }> {
  let trusted = start;
  const accepted: SignedKeySet[] = [];
  try {
    for (let page = 0; page < MAX_KEY_PAGES; page++) {
      const sets = await client.keySetsSince(trusted.issued_at);
      let progressed = false;
      let refused = false;
      for (const set of sets) {
        const step = acceptNext(set, trusted);
        if (step.ok) {
          trusted = step.keySet;
          accepted.push(set);
          progressed = true;
        } else if (step.reason !== 'stale_keyset') {
          log.warn(`Published key set refused: ${step.reason}`);
          refused = true;
          break;
        }
      }
      if (!progressed || refused) break;
    }
  } catch (err) {
    if (!(err instanceof ParentUnavailable || err instanceof ParentRefusal)) throw err;
    log.warn(`Key sets not fetched: ${err.message}`);
  }
  return { trusted, accepted };
}

/**
 * Ruling 7: the stored chain is replayed from the pinned root, set by set in
 * order (a set re-checked against the set it produced reports unknown_key, so
 * never out of order). Stale sets are skipped. At the first other refusal the
 * replay stops and keeps the prefix that did chain: only what chains is
 * trusted, and `complete: false` tells the caller to rebuild from the network.
 */
export function replayKeyChain(
  root: KeySet,
  stored: unknown,
  log: Log,
): { trusted: KeySet; chain: SignedKeySet[]; complete: boolean } {
  let trusted = root;
  const chain: SignedKeySet[] = [];
  for (const set of Array.isArray(stored) ? (stored as SignedKeySet[]) : []) {
    const step = acceptNext(set, trusted);
    if (step.ok) {
      trusted = step.keySet;
      chain.push(set);
      continue;
    }
    if (step.reason === 'stale_keyset') continue;
    log.error(
      `Stored key chain stops replaying from HOTEL_ROOT_KEYSET after ${chain.length} set(s) (${step.reason}); trusting only what chained`,
    );
    return { trusted, chain, complete: false };
  }
  return { trusted, chain, complete: true };
}
