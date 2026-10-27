import type { KeySet, LicenseEnvelope, SignedKeySet, VerifierMemory } from '@platform/licensing';
import { createTestDb, type TestDb } from '../../test/db';
import { DomainError } from '../common/domain-error';
import { LicenceStore } from './licence.store';

function envelope(revision: number): LicenseEnvelope {
  return { format: 1, key_id: 'k', signature: 'sig', payload: { revision } as never };
}

const keySet: KeySet = { issued_at: '2026-01-01T00:00:00.000Z', keys: [] };

function signedSet(issuedAt: string): SignedKeySet {
  return { format: 1, key_id: 'k', signature: 'sig', payload: { type: 'keyset', issued_at: issuedAt, keys: [] } };
}
const memory: VerifierMemory = { highestRevision: 1, maxIssuedAt: null, lastServerTime: null };

describe('LicenceStore', () => {
  let t: TestDb;
  let store: LicenceStore;

  beforeAll(async () => {
    t = await createTestDb();
    store = new LicenceStore(t.db);
  });
  beforeEach(async () => {
    await t.truncate();
  });
  afterAll(async () => {
    await t.close();
  });

  const activation = (installationId: string) => ({
    installationId,
    privateSeedEnc: 'v1.a.b.c',
    envelope: envelope(1),
    keySet,
    keyChain: [] as SignedKeySet[],
    memory,
  });

  it('get() is null before activation and returns the row after', async () => {
    expect(await store.get()).toBeNull();
    await store.saveActivation(activation('inst-1'));

    expect(await store.get()).toMatchObject({
      installationId: 'inst-1',
      privateSeedEnc: 'v1.a.b.c',
      keySet,
      keyChain: [],
      memory,
    });
  });

  it('holds one row only: a second activation is 409 already_activated', async () => {
    await store.saveActivation(activation('inst-1'));
    const err = await store.saveActivation(activation('inst-2')).catch((e) => e);

    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: 'already_activated', status: 409 });
    expect((await store.get())!.installationId).toBe('inst-1');
  });

  it('saveLicence replaces the licence and memory, but never with an older revision', async () => {
    await store.saveActivation(activation('inst-1'));
    const newer = { ...memory, highestRevision: 3 };

    expect(await store.saveLicence(envelope(3), newer)).toBe(true);
    expect(await store.saveLicence(envelope(2), { ...memory, highestRevision: 2 })).toBe(false);

    const row = await store.get();
    expect(row!.envelope.payload.revision).toBe(3);
    expect(row!.memory).toEqual(newer);
  });

  it('saveKeyChain writes chain and trusted set together for a newer or equal set', async () => {
    await store.saveActivation(activation('inst-1'));
    const later: KeySet = { issued_at: '2026-02-01T00:00:00.000Z', keys: [] };

    expect(await store.saveKeyChain([signedSet('2026-02-01T00:00:00.000Z')], later)).toBe(true);
    expect(await store.get()).toMatchObject({ keySet: later, keyChain: [signedSet('2026-02-01T00:00:00.000Z')] });
    // Same issued_at again: idempotent rewrite.
    expect(await store.saveKeyChain([signedSet('2026-02-01T00:00:00.000Z')], later)).toBe(true);
  });

  it('saveKeyChain never replaces a newer trusted set with an older one', async () => {
    await store.saveActivation(activation('inst-1'));
    const later: KeySet = { issued_at: '2026-03-01T00:00:00.000Z', keys: [] };
    await store.saveKeyChain([signedSet(later.issued_at)], later);

    const older: KeySet = { issued_at: '2026-02-01T00:00:00.000Z', keys: [] };
    expect(await store.saveKeyChain([signedSet(older.issued_at)], older)).toBe(false);

    expect(await store.get()).toMatchObject({ keySet: later, keyChain: [signedSet(later.issued_at)] });
  });

  it('saveMemory updates the memory column', async () => {
    await store.saveActivation(activation('inst-1'));
    const mem: VerifierMemory = { highestRevision: 1, maxIssuedAt: null, lastServerTime: '2026-02-01T00:00:00.000Z' };

    await store.saveMemory(mem);

    expect((await store.get())!.memory).toEqual(mem);
  });
});
