import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import {
  evaluateLicense,
  type KeySet,
  type LicenseEnvelope,
  type LicenseEvaluation,
  type SignedKeySet,
} from '@platform/licensing';
import { DomainError } from '../common/domain-error';
import { PRODUCT } from './activation.service';
import {
  ParentRefusal,
  ParentUnavailable,
  type CentralAdminClient,
  type InstallationAuth,
} from './central-admin.client';
import { replayKeyChain, walkKeyChain } from './key-chain';
import { LicenceStore, type LicenceRecord } from './licence.store';
import { LICENSING_CONFIG, type LicensingConfig } from './licensing.config';

export const HEARTBEAT_INTERVAL_MS = 5 * 60_000;
export const KEY_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;
/** How long an evaluation is reused; any licence or key change drops it at once. */
export const SNAPSHOT_TTL_MS = 60_000;

/** apps/hotel-api/package.json, from src/licensing and from dist/licensing alike. */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const APP_VERSION = readVersion();

export type LicenceState = 'VALID' | 'GRACE' | 'EXPIRED' | 'INVALID' | 'NOT_ACTIVATED';

/** What the rest of the API (and GET /licence) may know about the licence: no signature, no keys. */
export interface LicenceSnapshot {
  activated: boolean;
  state: LicenceState;
  modules: string[];
  limits: Record<string, number | null>;
  validUntil?: string;
  graceUntil?: string;
  reason?: string;
}

export type LimitKey = 'rooms' | 'users';

interface Held {
  record: LicenceRecord;
  /** What chained from HOTEL_ROOT_KEYSET at load, never the stored key_set; null without a root. */
  trusted: KeySet | null;
  /** The signed sets that produced `trusted`, oldest first. */
  chain: SignedKeySet[];
}

interface Evaluated {
  /** null = not activated. A synthesised INVALID stands in for local refusals. */
  evaluation: LicenseEvaluation | null;
  snapshot: LicenceSnapshot;
}

const NOT_ACTIVATED: LicenceSnapshot = Object.freeze({
  activated: false,
  state: 'NOT_ACTIVATED',
  modules: Object.freeze([]) as unknown as string[],
  limits: Object.freeze({}) as Record<string, number | null>,
  reason: 'not_activated',
}) as LicenceSnapshot;

function invalid(reason: string): Evaluated {
  return {
    // The resolver only reads `.state` of an INVALID evaluation.
    evaluation: { state: 'INVALID', reason: 'bad_format' },
    snapshot: Object.freeze({
      activated: true,
      state: 'INVALID',
      modules: Object.freeze([]) as unknown as string[],
      limits: Object.freeze({}) as Record<string, number | null>,
      reason,
    }) as LicenceSnapshot,
  };
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/**
 * The licence in operation: holds the stored licence, evaluates it against the
 * key set that chains from HOTEL_ROOT_KEYSET, and keeps both fresh.
 *
 * Timers: start() runs one heartbeat and one key refresh at once, then a
 * heartbeat every HEARTBEAT_INTERVAL_MS and a key refresh every
 * KEY_REFRESH_INTERVAL_MS; a heartbeat after which the held licence is INVALID
 * unknown_key also refreshes the keys. heartbeat(), refreshKeys()
 * and reload() are public so tests (and activation) can drive them directly;
 * concurrent calls of the same one share a single run.
 *
 * A failure to reach the Admin Panel never changes the state: the held licence
 * keeps being evaluated against the clock (VALID, then GRACE, then EXPIRED).
 */
@Injectable()
export class LicenceService implements OnApplicationShutdown {
  private readonly logger = new Logger(LicenceService.name);
  private held: Held | null = null;
  private cache: (Evaluated & { at: number }) | null = null;
  private timers: NodeJS.Timeout[] = [];
  private heartbeatRun: Promise<void> | null = null;
  private keysRun: Promise<void> | null = null;

  constructor(
    private readonly store: LicenceStore,
    @Inject(LICENSING_CONFIG) private readonly config: LicensingConfig,
  ) {}

  /** Loads the licence and starts the timers. Called by main.ts after migrations. */
  async start(): Promise<void> {
    await this.reload();
    if (this.timers.length > 0) return;
    this.timers = [
      setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS),
      setInterval(() => void this.refreshKeys(), KEY_REFRESH_INTERVAL_MS),
    ];
    for (const timer of this.timers) timer.unref();
    void this.heartbeat();
    // At once, not after 24 h: a stored chain that stopped replaying, or a
    // rotation while the API was down, must not leave the licence unverifiable.
    void this.refreshKeys();
  }

  /** Resolves when the heartbeat and key refresh in flight (if any) are done. Starts nothing. */
  async idle(): Promise<void> {
    await Promise.all([this.heartbeatRun, this.keysRun]);
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  onApplicationShutdown(): void {
    this.stop();
  }

  /**
   * Re-reads the stored licence and replays the stored key chain from the
   * root. Call after anything else wrote the row (activation).
   */
  async reload(): Promise<void> {
    const record = await this.store.get();
    if (!record) {
      this.held = null;
    } else {
      const { trusted, chain } = this.replay(record.keyChain);
      this.held = { record, trusted, chain };
    }
    this.cache = null;
  }

  snapshot(): LicenceSnapshot {
    return this.current().snapshot;
  }

  /** The evaluation the guard resolves against; null when not activated. */
  evaluation(): LicenseEvaluation | null {
    return this.current().evaluation;
  }

  /**
   * Refuses `wanted` units of `key` beyond the licence limit with 403
   * limit_exceeded. A null limit is unlimited; a key the licence does not
   * carry (or no usable licence) is refused: unknown is closed.
   */
  assertLimit(key: LimitKey, wanted: number): void {
    // A NaN would pass every `wanted > limit` comparison: a caller bug, not a quantity.
    if (!Number.isSafeInteger(wanted) || wanted < 0) {
      throw new TypeError(`assertLimit: wanted must be a non-negative safe integer (got ${wanted})`);
    }
    const { limits } = this.snapshot();
    const limit = Object.prototype.hasOwnProperty.call(limits, key) ? limits[key] : undefined;
    if (limit === null) return;
    if (limit === undefined || wanted > limit) {
      const allowed = limit ?? 0;
      throw new DomainError(
        'limit_exceeded',
        `Licenca dozvoljava najviše ${allowed} (${key}); traženo je ${wanted}.`,
        403,
        { key, limit: allowed, wanted },
      );
    }
  }

  heartbeat(): Promise<void> {
    if (!this.heartbeatRun) {
      this.heartbeatRun = this.runHeartbeat()
        .then(() => this.recoverTrust())
        .catch((err) => this.logger.error(`Heartbeat failed unexpectedly: ${(err as Error)?.message}`))
        .finally(() => {
          this.heartbeatRun = null;
        });
    }
    return this.heartbeatRun;
  }

  refreshKeys(): Promise<void> {
    if (!this.keysRun) {
      this.keysRun = this.runRefreshKeys()
        .catch((err) => this.logger.error(`Key refresh failed unexpectedly: ${(err as Error)?.message}`))
        .finally(() => {
          this.keysRun = null;
        });
    }
    return this.keysRun;
  }

  private now(): Date {
    return (this.config.now ?? (() => new Date()))();
  }

  private current(): Evaluated {
    const now = this.now();
    const t = now.getTime();
    // A clock that moved backwards re-evaluates at once, so a rollback is not
    // hidden behind the cache.
    if (!this.cache || t - this.cache.at >= SNAPSHOT_TTL_MS || t < this.cache.at) {
      this.cache = { at: t, ...this.evaluate(now) };
    }
    return this.cache;
  }

  private evaluate(now: Date): Evaluated {
    const held = this.held;
    if (!held) return { evaluation: null, snapshot: NOT_ACTIVATED };
    if (!held.trusted) return invalid('licensing_not_configured');
    let evaluation: LicenseEvaluation;
    try {
      evaluation = evaluateLicense({
        envelope: held.record.envelope,
        installationId: held.record.installationId,
        keySet: held.trusted,
        memory: held.record.memory,
        now,
      });
    } catch (err) {
      // The SDK throws only for corrupt stored memory: fail closed.
      this.logger.error(`Licence evaluation failed: ${(err as Error)?.message}`);
      return invalid('memory_corrupt');
    }
    if (evaluation.state === 'INVALID') return invalid(evaluation.reason);
    const { payload } = evaluation;
    if (payload.product !== PRODUCT) return invalid('wrong_product');
    return {
      evaluation,
      snapshot: Object.freeze({
        activated: true,
        state: evaluation.state,
        modules: Object.freeze([...payload.modules]) as unknown as string[],
        limits: Object.freeze({ ...payload.limits }) as Record<string, number | null>,
        validUntil: payload.valid_until,
        graceUntil: payload.grace_until,
      }) as LicenceSnapshot,
    };
  }

  /**
   * Ruling 7: the database is not a trust anchor. The stored chain is replayed
   * from HOTEL_ROOT_KEYSET (key-chain.ts) and only the prefix that chains is
   * trusted; never the stored key_set. An incomplete replay is rebuilt by the
   * key refresh that start() runs at once.
   */
  private replay(stored: SignedKeySet[]): { trusted: KeySet | null; chain: SignedKeySet[] } {
    const root = this.config.rootKeySet;
    if (!root) {
      this.logger.error('HOTEL_ROOT_KEYSET is not set: no licence can be verified');
      return { trusted: null, chain: [] };
    }
    const { trusted, chain } = replayKeyChain(root, stored, this.logger);
    return { trusted, chain };
  }

  /**
   * The held licence no longer verifies against what is trusted (unknown_key,
   * e.g. the stored chain stopped replaying, or keys rotated): fetch the
   * published key sets now instead of waiting for the daily refresh.
   */
  private async recoverTrust(): Promise<void> {
    if (!this.held) return;
    const { snapshot } = this.evaluate(this.now());
    if (snapshot.state === 'INVALID' && snapshot.reason === 'unknown_key') await this.refreshKeys();
  }

  private auth(): { client: CentralAdminClient; auth: InstallationAuth } | null {
    const { client, secretBox } = this.config;
    if (!this.held || !client || !secretBox) return null;
    try {
      const privateKey = secretBox.open(this.held.record.privateSeedEnc);
      return { client, auth: { installationId: this.held.record.installationId, privateKey } };
    } catch {
      this.logger.error('The installation key cannot be opened with HOTEL_SECRET_KEY');
      return null;
    }
  }

  private async runHeartbeat(): Promise<void> {
    const signed = this.auth();
    if (!signed || !this.held) return;
    const { client, auth } = signed;

    let beat: { serverTime: string; latestRevision: number | null };
    try {
      beat = await client.heartbeat(auth, APP_VERSION);
    } catch (err) {
      if (err instanceof ParentUnavailable || err instanceof ParentRefusal) {
        this.logger.warn(`Heartbeat not answered: ${err.message}`);
        return;
      }
      throw err;
    }

    await this.recordServerTime(beat.serverTime);
    if (!this.held) return;
    const heldRevision = this.held.record.envelope.payload.revision;
    if (beat.latestRevision !== null && beat.latestRevision > heldRevision) {
      await this.fetchLicence(client, auth, heldRevision);
    }
  }

  /** memory.lastServerTime only moves forward: the rollback guard never weakens. */
  private async recordServerTime(serverTime: string): Promise<void> {
    if (!this.held) return;
    if (!ISO_UTC.test(serverTime) || Number.isNaN(Date.parse(serverTime))) {
      this.logger.warn('Heartbeat serverTime is not a UTC timestamp; ignored');
      return;
    }
    const memory = this.held.record.memory;
    const previous = memory.lastServerTime;
    if (previous !== null && Date.parse(previous) >= Date.parse(serverTime)) return;
    const next = { ...memory, lastServerTime: serverTime };
    await this.store.saveMemory(next);
    this.held.record.memory = next;
    this.cache = null;
  }

  private async fetchLicence(client: CentralAdminClient, auth: InstallationAuth, heldRevision: number): Promise<void> {
    let fetched;
    try {
      fetched = await client.fetchLicence(auth, heldRevision);
    } catch (err) {
      if (err instanceof ParentUnavailable || err instanceof ParentRefusal) {
        this.logger.warn(`Licence not fetched: ${err.message}`);
        return;
      }
      throw err;
    }
    if (fetched.status === 'unchanged') return;

    let evaluation = this.evaluateCandidate(fetched.envelope);
    if (evaluation?.state === 'INVALID' && evaluation.reason === 'unknown_key') {
      // Signed by a key we do not trust yet: one key refresh, then once more.
      await this.refreshKeys();
      evaluation = this.evaluateCandidate(fetched.envelope);
    }
    if (!evaluation || evaluation.state === 'INVALID') {
      this.logger.warn(`New licence refused: ${evaluation ? evaluation.reason : 'no trusted key set'}`);
      return;
    }
    if (evaluation.payload.product !== PRODUCT) {
      this.logger.warn(`New licence refused: product "${evaluation.payload.product}"`);
      return;
    }
    const envelope = fetched.envelope as LicenseEnvelope;
    if (await this.store.saveLicence(envelope, evaluation.memory)) {
      if (this.held) {
        this.held.record.envelope = envelope;
        this.held.record.memory = evaluation.memory;
      }
      this.cache = null;
    } else {
      // A newer revision is already stored (another instance): take that one.
      await this.reload();
    }
  }

  private evaluateCandidate(envelope: unknown): LicenseEvaluation | null {
    if (!this.held?.trusted) return null;
    try {
      return evaluateLicense({
        envelope,
        installationId: this.held.record.installationId,
        keySet: this.held.trusted,
        memory: this.held.record.memory,
        now: this.now(),
      });
    } catch (err) {
      this.logger.error(`Licence evaluation failed: ${(err as Error)?.message}`);
      return null;
    }
  }

  /**
   * Accepts the sets published after the trusted one, in order, and stores the
   * FULL chain from the root (the store overwrites key_chain). The accepted
   * sets are verified here, so they are used even if the store refuses to
   * write them (it already holds a later set).
   */
  private async runRefreshKeys(): Promise<void> {
    const held = this.held;
    const client = this.config.client;
    if (!held?.trusted || !client) return;
    const walked = await walkKeyChain(client, held.trusted, this.logger);
    if (walked.accepted.length === 0) return;
    const trusted = walked.trusted;
    // The FULL chain from the root: the store overwrites key_chain.
    const chain = [...held.chain, ...walked.accepted];

    if (!(await this.store.saveKeyChain(chain, trusted))) {
      this.logger.warn('A later key set is already stored; the accepted chain is used but not written');
    }
    if (this.held === held) {
      held.trusted = trusted;
      held.chain = chain;
      held.record.keySet = trusted;
      held.record.keyChain = chain;
    }
    this.cache = null;
  }
}
