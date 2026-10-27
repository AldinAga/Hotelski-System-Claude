import { randomBytes } from 'node:crypto';
import { createTestDb, type TestDb } from '../../test/db';
import { startFakeCentralAdmin, type FakeCentralAdmin, type IssueCodeOptions } from '../../test/fake-central-admin';
import { AuditService } from '../common/audit.service';
import { DomainError } from '../common/domain-error';
import { ActivationService } from './activation.service';
import { CentralAdminClient } from './central-admin.client';
import { LicenceStore } from './licence.store';
import {
  HEARTBEAT_INTERVAL_MS,
  KEY_REFRESH_INTERVAL_MS,
  LicenceService,
  SNAPSHOT_TTL_MS,
} from './licence.service';
import { parseRootKeySet, type LicensingConfig } from './licensing.config';
import { SecretBox } from './secret-box';

const DAY_MS = 86_400_000;

function catchDomain(fn: () => void): DomainError {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err;
    throw err;
  }
  throw new Error('expected a DomainError');
}

describe('LicenceService', () => {
  let t: TestDb;
  let fake: FakeCentralAdmin;
  let store: LicenceStore;
  let config: LicensingConfig;
  // The service's clock; tests move it.
  let clock: Date;
  let service: LicenceService;

  const requestsTo = (path: string) => fake.requests.filter((r) => r.path.startsWith(path));

  async function activate(opts: IssueCodeOptions = {}): Promise<void> {
    await new ActivationService(t.db, store, new AuditService(), config).activate(fake.issueCode(opts));
  }

  function newService(): LicenceService {
    return new LicenceService(store, config);
  }

  beforeAll(async () => {
    t = await createTestDb();
  });
  beforeEach(async () => {
    // A fresh fake per test: rotations and licence patches must not leak.
    fake = await startFakeCentralAdmin();
    await t.truncate();
    store = new LicenceStore(t.db);
    clock = new Date();
    config = {
      client: new CentralAdminClient({ baseUrl: fake.url, allowHttp: true }),
      rootKeySet: parseRootKeySet(JSON.stringify(fake.rootKeySet)),
      secretBox: new SecretBox(randomBytes(32)),
      now: () => clock,
    };
    service = newService();
  });
  afterEach(async () => {
    service.stop();
    await fake.close();
  });
  afterAll(async () => {
    await t.close();
  });

  it('not activated: NOT_ACTIVATED, no modules, no limits, and no heartbeat is sent', async () => {
    await service.reload();
    expect(service.snapshot()).toEqual({
      activated: false,
      state: 'NOT_ACTIVATED',
      modules: [],
      limits: {},
      reason: 'not_activated',
    });
    await service.heartbeat();
    expect(requestsTo('/v1/heartbeat')).toHaveLength(0);
  });

  it('activated: VALID with the modules, limits and dates of the licence', async () => {
    await activate();
    await service.reload();
    const record = await store.get();
    expect(service.snapshot()).toEqual({
      activated: true,
      state: 'VALID',
      modules: ['hotel.core'],
      limits: { rooms: 20 },
      validUntil: record!.envelope.payload.valid_until,
      graceUntil: record!.envelope.payload.grace_until,
    });
  });

  it('a heartbeat with a higher revision fetches the new licence', async () => {
    await activate();
    await service.reload();
    expect(service.snapshot().modules).toEqual(['hotel.core']);

    fake.setLicence({ modules: ['hotel.core', 'hotel.channel'], limits: { rooms: 50, users: 10 } });
    await service.heartbeat();

    const hb = requestsTo('/v1/heartbeat');
    expect(hb).toHaveLength(1);
    expect(JSON.parse(hb[0].body)).toEqual({ version: '0.0.0' });
    // Asked with the held revision; the fake answered with revision 2.
    const fetches = requestsTo('/v1/license');
    expect(fetches).toHaveLength(1);
    expect(fetches[0].headers['if-none-match']).toBe('"1"');

    const record = await store.get();
    expect(record!.envelope.payload.revision).toBe(2);
    expect(record!.memory.highestRevision).toBe(2);
    expect(record!.memory.lastServerTime).not.toBeNull();
    // Visible immediately, not after the 60 s cache.
    expect(service.snapshot()).toMatchObject({
      state: 'VALID',
      modules: ['hotel.core', 'hotel.channel'],
      limits: { rooms: 50, users: 10 },
    });
  });

  it('a heartbeat with the same revision does not fetch the licence, but records serverTime', async () => {
    await activate();
    await service.reload();
    const serverTime = new Date(clock.getTime() + 60_000);
    fake.setServerTime(serverTime);
    await service.heartbeat();
    expect(requestsTo('/v1/heartbeat')).toHaveLength(1);
    expect(requestsTo('/v1/license')).toHaveLength(0);
    expect((await store.get())!.memory.lastServerTime).toBe(serverTime.toISOString());
  });

  it('Admin Panel down: VALID until valid_until, then GRACE, then EXPIRED', async () => {
    await activate();
    await service.reload();
    const payload = (await store.get())!.envelope.payload;
    fake.setDown(true);

    clock = new Date(Date.parse(payload.valid_until));
    await service.heartbeat();
    expect(service.snapshot().state).toBe('VALID');

    // Past valid_until and past the 60 s evaluation cache.
    clock = new Date(Date.parse(payload.valid_until) + SNAPSHOT_TTL_MS);
    await service.heartbeat();
    expect(service.snapshot()).toMatchObject({ state: 'GRACE', modules: ['hotel.core'] });

    clock = new Date(Date.parse(payload.grace_until) + 1);
    await service.heartbeat();
    expect(service.snapshot()).toMatchObject({ state: 'EXPIRED', modules: ['hotel.core'] });

    // The heartbeats did reach the (down) Admin Panel, and nothing was stored.
    expect(requestsTo('/v1/heartbeat')).toHaveLength(3);
    const record = await store.get();
    expect(record!.envelope.payload.revision).toBe(1);
    expect(record!.memory.lastServerTime).toBeNull();
  });

  it('clock set back below the last serverTime: INVALID clock_rollback', async () => {
    await activate();
    await service.reload();
    // The Admin Panel reports a time two days ahead, well after the licence's issued_at.
    const serverTime = new Date(clock.getTime() + 2 * DAY_MS);
    fake.setServerTime(serverTime);
    clock = serverTime;
    await service.heartbeat();
    expect(service.snapshot().state).toBe('VALID');

    // One day back: still a day after issued_at, so only the serverTime can catch it.
    clock = new Date(serverTime.getTime() - DAY_MS);
    expect(service.snapshot()).toMatchObject({ state: 'INVALID', reason: 'clock_rollback', modules: [] });

    // Control: without that serverTime, the same clock is VALID.
    await store.saveMemory({ ...(await store.get())!.memory, lastServerTime: null });
    const fresh = newService();
    await fresh.reload();
    expect(fresh.snapshot().state).toBe('VALID');
  });

  it('a serverTime older than the stored one does not move lastServerTime back', async () => {
    await activate();
    await service.reload();
    const later = new Date(clock.getTime() + DAY_MS);
    fake.setServerTime(later);
    clock = later;
    await service.heartbeat();
    fake.setServerTime(new Date(later.getTime() - 3_600_000));
    await service.heartbeat();
    expect((await store.get())!.memory.lastServerTime).toBe(later.toISOString());
  });

  it('key rotation: the new key set is accepted and a licence signed with the new key is VALID', async () => {
    await activate(); // trusts root-1 + k2
    await service.reload();
    const newKey = fake.rotateKeys(); // publishes a k3-signed set adding k4, re-signs the licence with k4
    expect(newKey).toBe('k4');

    await service.heartbeat();

    const record = await store.get();
    expect(record!.envelope.key_id).toBe('k4');
    expect(record!.envelope.payload.revision).toBe(2);
    expect(record!.keySet.keys.map((k) => k.key_id)).toEqual(['root-1', 'k2', 'k3', 'k4']);
    // The FULL chain from the root, in order, not only the delta.
    expect(record!.keyChain.map((s) => s.key_id)).toEqual(['root-1', 'k2', 'k3']);
    // One refresh: the walk from the trusted set, then one more page that brings nothing.
    expect(requestsTo('/v1/keys?since=').map((r) => r.path)).toEqual([
      `/v1/keys?since=${encodeURIComponent(record!.keyChain[0].payload.issued_at)}`,
      `/v1/keys?since=${encodeURIComponent(record!.keySet.issued_at)}`,
    ]);
    expect(service.snapshot().state).toBe('VALID');

    // After a restart the chain replays from HOTEL_ROOT_KEYSET, with no network.
    fake.setDown(true);
    const restarted = newService();
    await restarted.reload();
    expect(restarted.snapshot().state).toBe('VALID');
  });

  it('a licence signed by a key that no published set vouches for is not stored', async () => {
    await activate();
    await service.reload();
    // The licence is re-signed with a fresh key; the published set that vouches
    // for it is hidden, so the one key refresh finds nothing.
    fake.rotateKeys();
    const since = jest.spyOn(config.client!, 'keySetsSince').mockResolvedValue([]);
    await service.heartbeat();
    expect(requestsTo('/v1/license')).toHaveLength(1);
    expect(since).toHaveBeenCalledTimes(1);
    const record = await store.get();
    expect(record!.envelope.payload.revision).toBe(1);
    expect(service.snapshot().state).toBe('VALID');
  });

  it('the database is not a trust anchor: a stored chain that does not replay falls back to the root', async () => {
    await activate();
    await service.reload();
    fake.rotateKeys();
    await service.heartbeat();
    expect(service.snapshot().state).toBe('VALID');

    // Tamper: keep the trusted set (which holds k4) but replace the chain with a foreign set.
    const record = (await store.get())!;
    const last = record.keyChain[2];
    const forged = { ...last, signature: (last.signature[0] === 'A' ? 'B' : 'A') + last.signature.slice(1) };
    await t.pool.query('UPDATE installation_licence SET key_chain = $1', [
      JSON.stringify([record.keyChain[0], record.keyChain[1], forged]),
    ]);
    // The stored trusted set still holds k4: trusting it would make the licence VALID.
    expect((await store.get())!.keySet.keys.map((k) => k.key_id)).toContain('k4');

    fake.setDown(true);
    const restarted = newService();
    await restarted.reload();
    // Only the root is trusted, so the k4-signed licence does not verify.
    expect(restarted.snapshot()).toMatchObject({ state: 'INVALID', reason: 'unknown_key' });
  });

  it('daily key refresh appends newly published sets to the full chain', async () => {
    // Activated as after two rotations: trusts root-1, k2, k3; the licence is
    // signed by k3, the current key. (The default 'rotated' licence is signed
    // by k2 after the published second rotation retired it, so it stops
    // verifying once that set is trusted, as SPEC 5 requires.)
    await activate({ keySet: 'rotated-twice' });
    await service.reload();
    const activatedTrust = (await store.get())!.keySet.issued_at;
    const before = fake.requests.length;
    const keyRequests = () => fake.requests.slice(before).filter((r) => r.path.startsWith('/v1/keys?since='));
    fake.rotateKeys();
    // The licence is not fetched here: only the key refresh runs.
    await service.refreshKeys();
    const record = await store.get();
    expect(record!.keyChain.map((s) => s.key_id)).toEqual(['root-1', 'k2', 'k3']);
    expect(record!.keySet.keys.map((k) => k.key_id)).toEqual(['root-1', 'k2', 'k3', 'k4']);
    // Asked from the trusted set's issued_at, then once more from the newest
    // accepted set, which brings nothing.
    expect(keyRequests().map((r) => r.path)).toEqual([
      `/v1/keys?since=${encodeURIComponent(activatedTrust)}`,
      `/v1/keys?since=${encodeURIComponent(record!.keySet.issued_at)}`,
    ]);
    expect(requestsTo('/v1/license')).toHaveLength(0);
    // The held k3 licence still verifies under the new set.
    expect(service.snapshot().state).toBe('VALID');
    // The k4-signed licence verifies on the next fetch without another refresh.
    await service.heartbeat();
    expect((await store.get())!.envelope.key_id).toBe('k4');
    expect(keyRequests()).toHaveLength(2);
    expect(service.snapshot().state).toBe('VALID');
  });

  it('Admin Panel down during the key refresh: nothing changes', async () => {
    await activate();
    await service.reload();
    const before = await store.get();
    fake.setDown(true);
    await service.refreshKeys();
    const after = await store.get();
    expect(after!.keyChain).toEqual(before!.keyChain);
    expect(after!.keySet).toEqual(before!.keySet);
    expect(service.snapshot().state).toBe('VALID');
  });

  it('the evaluation is cached for 60 s', async () => {
    await activate();
    await service.reload();
    const payload = (await store.get())!.envelope.payload;
    clock = new Date(Date.parse(payload.valid_until) - 1_000);
    expect(service.snapshot().state).toBe('VALID');
    clock = new Date(clock.getTime() + 2_000); // past valid_until, inside the cache window
    expect(service.snapshot().state).toBe('VALID');
    clock = new Date(clock.getTime() + SNAPSHOT_TTL_MS);
    expect(service.snapshot().state).toBe('GRACE');
  });

  it('start() schedules the heartbeat every 5 minutes and the key refresh every 24 hours; stop() ends both', async () => {
    jest.spyOn(service, 'reload').mockResolvedValue();
    const heartbeat = jest.spyOn(service, 'heartbeat').mockResolvedValue();
    const refresh = jest.spyOn(service, 'refreshKeys').mockResolvedValue();
    jest.useFakeTimers();
    try {
      await service.start();
      expect(heartbeat).toHaveBeenCalledTimes(1); // once at start
      jest.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 1);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      expect(heartbeat).toHaveBeenCalledTimes(2);
      expect(HEARTBEAT_INTERVAL_MS).toBe(5 * 60_000);

      expect(refresh).toHaveBeenCalledTimes(0);
      jest.advanceTimersByTime(KEY_REFRESH_INTERVAL_MS);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(KEY_REFRESH_INTERVAL_MS).toBe(DAY_MS);

      service.stop();
      const calls = heartbeat.mock.calls.length;
      jest.advanceTimersByTime(2 * KEY_REFRESH_INTERVAL_MS);
      expect(heartbeat).toHaveBeenCalledTimes(calls);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  describe('assertLimit', () => {
    async function withLimits(limits: Record<string, number | null>): Promise<void> {
      await activate({ licence: { limits } });
      await service.reload();
    }

    it('rooms = 2, wanted = 3: limit_exceeded with key, limit, wanted', async () => {
      await withLimits({ rooms: 2 });
      const err = catchDomain(() => service.assertLimit('rooms', 3));
      expect(err.code).toBe('limit_exceeded');
      expect(err.status).toBe(403);
      expect(err.details).toEqual({ key: 'rooms', limit: 2, wanted: 3 });
      // The boundary is allowed.
      expect(() => service.assertLimit('rooms', 2)).not.toThrow();
    });

    it('rooms = null: no limit', async () => {
      await withLimits({ rooms: null });
      expect(() => service.assertLimit('rooms', 1_000_000)).not.toThrow();
    });

    it('a key the licence does not have: limit_exceeded (unknown is closed)', async () => {
      await withLimits({ rooms: 5 });
      const err = catchDomain(() => service.assertLimit('users', 1));
      expect(err.code).toBe('limit_exceeded');
      expect(err.details).toEqual({ key: 'users', limit: 0, wanted: 1 });
    });

    it('not activated: limit_exceeded', async () => {
      await service.reload();
      expect(catchDomain(() => service.assertLimit('rooms', 1)).code).toBe('limit_exceeded');
    });
  });
});
