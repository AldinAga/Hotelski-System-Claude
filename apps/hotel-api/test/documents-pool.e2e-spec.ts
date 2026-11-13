import { startFrontDesk, type FrontDesk } from './front-desk';

// A request that holds a transaction connection must not ask the pool for a
// second one: with a pool of one client that request would wait for itself
// forever (pool.ts sets no connection timeout). The folio view and the
// document issue read the legal profile inside their transaction.

describe('folio documents on a pool of one connection (e2e)', () => {
  let fd: FrontDesk;
  let typeId: string;
  let planId: string;
  let unitIds: string[];

  beforeAll(async () => {
    fd = await startFrontDesk({ poolMax: 1 });
  });
  beforeEach(async () => {
    await fd.reset();
    ({ typeId, planId, unitIds } = await fd.pricedType('DBL', 3));
  });
  afterAll(() => fd.close());

  /** The answer, or a failure after `ms` when the request is still waiting. */
  const answered = <T>(request: PromiseLike<T>, ms = 8_000): Promise<T> =>
    Promise.race([
      Promise.resolve(request),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)),
    ]);

  it('the folio view answers with one pool connection', async () => {
    const s = await fd.inHouse({ typeId, planId, unitId: unitIds[0] }, '2026-11-02', '2026-11-03');
    const res = await answered(fd.get(`/stays/${s.stayId}/folio`));
    expect(res.status).toBe(200);
    expect(res.body.stayId).toBe(s.stayId);
  }, 30_000);

  it('issuing a document answers with one pool connection', async () => {
    const s = await fd.inHouse({ typeId, planId, unitId: unitIds[0] }, '2026-11-02', '2026-11-03');
    const pay = await answered(fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'cash', amountMinor: 10_000, key: 'pay-pool-00001' }));
    expect(pay.status).toBe(201);
    const res = await answered(fd.post(`/stays/${s.stayId}/folio/documents`, { kind: 'receipt', key: 'doc-pool-00001' }));
    expect(res.status).toBe(201);
    expect(res.body.number).toBe('N-2026-000001');
  }, 30_000);
});
