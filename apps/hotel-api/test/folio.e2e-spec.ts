import { BusinessDayService } from '../src/business-day/business-day.service';
import { PropertyContext } from '../src/common/property-context';
import { FolioNotOpen, FolioService, NightWithoutPrice } from '../src/folio/folio.service';
import { startFrontDesk, type FrontDesk } from './front-desk';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('folio (e2e)', () => {
  let fd: FrontDesk;
  let stayId: string;
  let reservationId: string;
  let version: number;
  let typeId: string;
  let planId: string;
  let pid: string;

  beforeAll(async () => {
    // 20 parallel payments hold 20 transactions at once, plus the barrier's holder and
    // poller: above pg's default of 10 clients (Ruling 27a).
    fd = await startFrontDesk({ poolMax: 30 });
  });
  beforeEach(async () => {
    await fd.reset();
    ({ typeId, planId } = await fd.pricedType('DBL', 2));
    ({ stayId, reservationId, version } = await fd.bookStay({ typeId, planId }, '2026-11-02', '2026-11-04'));
    pid = await fd.app.get(PropertyContext).id();
  });
  afterAll(() => fd.close());

  const charge = (amountMinor: number, key: string, cookie?: string) =>
    fd.post(`/stays/${stayId}/folio/charges`, { kind: 'service', description: 'Mini bar', amountMinor, key }, cookie);
  const pay = (amountMinor: number, key: string, method = 'cash') =>
    fd.post(`/stays/${stayId}/folio/payments`, { method, amountMinor, key });
  const folio = async () => (await fd.get(`/stays/${stayId}/folio`)).body;

  const raceUnderHeldDay = <T>(n: number, fire: () => Array<PromiseLike<T>>) => fd.raceUnderHeldDay(n, fire);

  it('GET before any write shows an empty folio and creates nothing', async () => {
    expect(await folio()).toMatchObject({ id: null, status: 'none', balanceMinor: 0, lines: [], payments: [] });
    expect((await folio()).unpostedNights).toEqual([
      { night: '2026-11-02', priceMinor: 1_000_000 },
      { night: '2026-11-03', priceMinor: 1_000_000 },
    ]);
    expect(await fd.sql('SELECT 1 FROM folio')).toHaveLength(0);
    // Nor a business day: GET never writes.
    expect(await fd.sql('SELECT 1 FROM business_day')).toHaveLength(0);
  });

  it('balance is charges minus payments, on the open business date', async () => {
    expect((await charge(50_000, 'charge-0001')).status).toBe(201);
    expect((await pay(30_000, 'pay-00000001')).status).toBe(201);
    const f = await folio();
    expect(f).toMatchObject({ status: 'open', chargesMinor: 50_000, paymentsMinor: 30_000, balanceMinor: 20_000 });
    expect(f.lines).toEqual([
      expect.objectContaining({ kind: 'service', amountMinor: 50_000, businessDate: '2026-11-02', sourceType: 'manual' }),
    ]);
    expect(f.payments).toEqual([expect.objectContaining({ method: 'cash', amountMinor: 30_000, businessDate: '2026-11-02' })]);
  });

  it('the posting date is the open business day, not the calendar date', async () => {
    // The calendar says 2026-11-02 (NOW); the open day lags behind on 2026-11-01.
    await fd.sql(`INSERT INTO business_day (property_id, day, status) VALUES ($1, '2026-11-01', 'open')`, [pid]);
    expect((await charge(50_000, 'charge-late-1')).body.businessDate).toBe('2026-11-01');
    expect((await pay(10_000, 'pay-late-0001')).body.businessDate).toBe('2026-11-01');
  });

  it('the same key twice, even in parallel, records one payment; another body with that key is 409', async () => {
    // The folio exists first, so the two requests meet at its row lock (not at its insert).
    expect((await charge(5_000, 'charge-warm-1')).status).toBe(201);
    const body = { method: 'card', amountMinor: 10_000, key: 'pay-retry-01' };
    const url = `/stays/${stayId}/folio/payments`;
    const [a, b] = await raceUnderHeldDay(2, () => [fd.post(url, body), fd.post(url, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(b.body.id).toBe(a.body.id);
    expect(await fd.sql('SELECT id FROM payment')).toHaveLength(1);
    const c = await fd.post(url, { ...body, amountMinor: 10_001 });
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('idempotency_key_reused');
  });

  it('the same key on two stays at once: one payment, the other is 409 idempotency_key_reused', async () => {
    const other = await fd.bookStay({ typeId, planId }, '2026-11-02', '2026-11-03');
    const body = { method: 'cash', amountMinor: 10_000, key: 'pay-twofolio' };
    const res = await raceUnderHeldDay(2, () => [
      fd.post(`/stays/${stayId}/folio/payments`, body),
      fd.post(`/stays/${other.stayId}/folio/payments`, body),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(res.find((r) => r.status === 409)!.body.code).toBe('idempotency_key_reused');
    expect(await fd.sql('SELECT id FROM payment')).toHaveLength(1);
  });

  it('a key used for a charge cannot be replayed as a payment', async () => {
    expect((await charge(50_000, 'shared-key-1')).status).toBe(201);
    const res = await pay(50_000, 'shared-key-1');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('idempotency_key_reused');
  });

  it('a key used on one stay cannot be replayed on another', async () => {
    const other = await fd.bookStay({ typeId, planId }, '2026-11-02', '2026-11-03');
    expect((await pay(10_000, 'pay-onestay-1')).status).toBe(201);
    const res = await fd.post(`/stays/${other.stayId}/folio/payments`, { method: 'cash', amountMinor: 10_000, key: 'pay-onestay-1' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('idempotency_key_reused');
  });

  it('a repeated charge, reversal, refund and void return the first result with 200 and write nothing', async () => {
    const first = await charge(50_000, 'charge-rep-1');
    const again = await charge(50_000, 'charge-rep-1');
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body).toEqual(first.body);

    const revBody = { reason: 'Pogrešan unos', key: 'reverse-rep-1' };
    const rev = await fd.post(`/folio-lines/${first.body.id}/reverse`, revBody, fd.manager);
    const rev2 = await fd.post(`/folio-lines/${first.body.id}/reverse`, revBody, fd.manager);
    expect([rev.status, rev2.status]).toEqual([201, 200]);
    expect(rev2.body.id).toBe(rev.body.id);

    await pay(30_000, 'pay-rep-0001');
    const refBody = { method: 'cash', amountMinor: 30_000, reason: 'Povraćaj', key: 'refund-rep-1' };
    const ref = await fd.post(`/stays/${stayId}/folio/refunds`, refBody, fd.manager);
    // The credit is used up now: only the key lookup can answer 200.
    const ref2 = await fd.post(`/stays/${stayId}/folio/refunds`, refBody, fd.manager);
    expect([ref.status, ref2.status]).toEqual([201, 200]);
    expect(ref2.body.id).toBe(ref.body.id);

    const voidBody = { reason: 'Greška', key: 'void-rep-0001' };
    const v = await fd.post(`/payments/${ref.body.id}/void`, voidBody, fd.manager);
    const v2 = await fd.post(`/payments/${ref.body.id}/void`, voidBody, fd.manager);
    expect([v.status, v2.status]).toEqual([201, 200]);
    expect(v2.body.id).toBe(v.body.id);

    expect(await fd.sql('SELECT 1 FROM folio_line')).toHaveLength(2);
    expect(await fd.sql('SELECT 1 FROM payment')).toHaveLength(3);
    expect(await fd.sql(`SELECT 1 FROM audit_log WHERE action LIKE 'folio.%'`)).toHaveLength(5);
  });

  it('a reversal is a new negative line, once, by a manager only', async () => {
    const line = (await charge(50_000, 'charge-0002')).body;
    const byDesk = await fd.post(`/folio-lines/${line.id}/reverse`, { reason: 'Pogrešan unos', key: 'reverse-001' });
    expect(byDesk.body.code).toBe('forbidden_role');
    const rev = await fd.post(`/folio-lines/${line.id}/reverse`, { reason: 'Pogrešan unos', key: 'reverse-001' }, fd.manager);
    expect(rev.status).toBe(201);
    expect(rev.body).toMatchObject({ kind: 'correction', amountMinor: -50_000, reversesLineId: line.id });
    const again = await fd.post(`/folio-lines/${line.id}/reverse`, { reason: 'Opet', key: 'reverse-002' }, fd.manager);
    expect(again.body.code).toBe('line_already_reversed');
    const ofReversal = await fd.post(`/folio-lines/${rev.body.id}/reverse`, { reason: 'x', key: 'reverse-003' }, fd.manager);
    expect(ofReversal.body.code).toBe('cannot_reverse_correction');
    expect((await folio()).balanceMinor).toBe(0);
  });

  it('a reversal carries the VAT rate and the reason; the view links both lines', async () => {
    await fd.put('/settings/business', { vatRatesBp: [1000, 2000] });
    const line = (await fd.post(`/stays/${stayId}/folio/charges`, {
      kind: 'fee', description: 'Parking', amountMinor: 12_000, vatRateBp: 2000, key: 'charge-vat-01',
    })).body;
    expect(line).toMatchObject({ kind: 'fee', vatRateBp: 2000, reversedBy: null });
    const rev = (await fd.post(`/folio-lines/${line.id}/reverse`, { reason: 'Pogrešan unos', key: 'reverse-vat-1' }, fd.manager)).body;
    expect(rev).toMatchObject({ vatRateBp: 2000, reason: 'Pogrešan unos', sourceType: 'reversal', description: 'Storno: Parking' });
    const f = await folio();
    expect(f.lines).toEqual([
      expect.objectContaining({ id: line.id, reversedBy: rev.id }),
      expect.objectContaining({ id: rev.id, reversesLineId: line.id, reversedBy: null }),
    ]);
    expect(f.vatRatesBp).toEqual([1000, 2000]);
  });

  it('vatRateBp that is not in the settings: 422 with field vatRateBp', async () => {
    await fd.put('/settings/business', { vatRatesBp: [1000, 2000] });
    const res = await fd.post(`/stays/${stayId}/folio/charges`, {
      kind: 'service', description: 'Mini bar', amountMinor: 1_000, vatRateBp: 800, key: 'charge-vat-02',
    });
    expect(res.status).toBe(422);
    expect(res.body.details).toEqual({ field: 'vatRateBp' });
    const ok = await fd.post(`/stays/${stayId}/folio/charges`, {
      kind: 'service', description: 'Mini bar', amountMinor: 1_000, vatRateBp: 1000, key: 'charge-vat-03',
    });
    expect(ok.status).toBe(201);
    expect(await fd.sql('SELECT vat_rate_bp FROM folio_line')).toEqual([{ vat_rate_bp: 1000 }]);
  });

  it('a refund needs a credit and cannot exceed it', async () => {
    await pay(30_000, 'pay-00000002');
    const tooMuch = await fd.post(
      `/stays/${stayId}/folio/refunds`,
      { method: 'cash', amountMinor: 30_001, reason: 'Povraćaj', key: 'refund-0001' },
      fd.manager,
    );
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body).toMatchObject({ code: 'refund_exceeds_credit', details: { creditMinor: 30_000 } });
    const ok = await fd.post(
      `/stays/${stayId}/folio/refunds`,
      { method: 'cash', amountMinor: 30_000, reason: 'Povraćaj', key: 'refund-0002' },
      fd.manager,
    );
    expect(ok.status).toBe(201);
    expect(ok.body.amountMinor).toBe(-30_000);
    expect((await folio()).balanceMinor).toBe(0);
  });

  it('a refund without a credit (balance due) is 422 with creditMinor 0', async () => {
    await charge(50_000, 'charge-0005');
    await pay(10_000, 'pay-00000005');
    const res = await fd.post(
      `/stays/${stayId}/folio/refunds`,
      { method: 'cash', amountMinor: 1, reason: 'Povraćaj', key: 'refund-0003' },
      fd.manager,
    );
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'refund_exceeds_credit', details: { creditMinor: 0 } });
  });

  it('refunds and voids are for managers: the receptionist gets forbidden_role', async () => {
    const p = (await pay(30_000, 'pay-00000006')).body;
    const refund = await fd.post(`/stays/${stayId}/folio/refunds`, { method: 'cash', amountMinor: 1_000, reason: 'x', key: 'refund-0004' });
    expect(refund.status).toBe(403);
    expect(refund.body.code).toBe('forbidden_role');
    const voided = await fd.post(`/payments/${p.id}/void`, { reason: 'x', key: 'void-desk-01' });
    expect(voided.status).toBe(403);
    expect(voided.body.code).toBe('forbidden_role');
    expect(await fd.sql('SELECT 1 FROM payment')).toHaveLength(1);
  });

  it('housekeeping gets 403 on GET of the folio', async () => {
    const res = await fd.get(`/stays/${stayId}/folio`, fd.housekeeping);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden_role');
  });

  it('a payment void twice: 409 payment_already_voided; a void cannot be voided', async () => {
    const p = (await pay(30_000, 'pay-00000007')).body;
    const v = await fd.post(`/payments/${p.id}/void`, { reason: 'Pogrešan iznos', key: 'void-0000001' }, fd.manager);
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({ method: 'cash', amountMinor: -30_000, reversesPaymentId: p.id, reason: 'Pogrešan iznos' });
    const twice = await fd.post(`/payments/${p.id}/void`, { reason: 'Opet', key: 'void-0000002' }, fd.manager);
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('payment_already_voided');
    const ofVoid = await fd.post(`/payments/${v.body.id}/void`, { reason: 'x', key: 'void-0000003' }, fd.manager);
    expect(ofVoid.status).toBe(422);
    expect(ofVoid.body.code).toBe('cannot_void_reversal');
    const f = await folio();
    expect(f).toMatchObject({ paymentsMinor: 0, balanceMinor: 0 });
    expect(f.payments).toEqual([
      expect.objectContaining({ id: p.id, voidedBy: v.body.id }),
      expect.objectContaining({ id: v.body.id, voidedBy: null }),
    ]);
  });

  it('a charge on a cancelled stay: 409 stay_not_chargeable; a payment still works', async () => {
    expect((await fd.post(`/reservations/${reservationId}/cancel`, { version })).status).toBe(200);
    const res = await charge(10_000, 'charge-cancel1');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'stay_not_chargeable', details: { status: 'cancelled' } });
    expect((await pay(10_000, 'pay-cancel-01')).status).toBe(201);
    // A cancelled stay has nothing left to post: its stay_night rows are not unposted nights.
    expect((await folio()).unpostedNights).toEqual([]);
  });

  it('a charge waits for a cancel in flight (reservation row) and then sees the cancelled stay', async () => {
    await pay(1_000, 'pay-opens-day'); // the business day and the folio exist, committed
    const holder = await fd.ta.testDb.pool.connect();
    let res: Awaited<ReturnType<typeof charge>> | null = null;
    let doneBeforeCommit = true;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM reservation WHERE id = $1 FOR UPDATE', [reservationId]);
      const pending = charge(10_000, 'charge-race-1').then((r) => (res = r));
      await delay(300);
      doneBeforeCommit = res !== null;
      await holder.query(`UPDATE stay SET status = 'cancelled' WHERE id = $1`, [stayId]);
      await holder.query('COMMIT');
      await pending;
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined); // no-op after COMMIT; releases the row if a step failed
      holder.release();
    }
    expect(doneBeforeCommit).toBe(false);
    expect(res!.status).toBe(409);
    expect(res!.body).toMatchObject({ code: 'stay_not_chargeable', details: { status: 'cancelled' } });
  });

  it('a closed folio takes no charge and no payment: 409 folio_closed', async () => {
    await charge(10_000, 'charge-close1');
    await pay(10_000, 'pay-close-001');
    await fd.sql(`UPDATE folio SET status = 'closed', closed_at = now()`);
    const c = await charge(10_000, 'charge-close2');
    const p = await pay(10_000, 'pay-close-002');
    expect([c.status, c.body.code, p.status, p.body.code]).toEqual([409, 'folio_closed', 409, 'folio_closed']);
    expect((await folio()).status).toBe('closed');
  });

  it('20 parallel payments of 1.000 with different keys: 20 rows and a balance of exactly −20.000', async () => {
    // No folio yet: all 20 race to create it (ensureFolio), then for its row lock.
    const n = 20;
    const res = await raceUnderHeldDay(n, () =>
      Array.from({ length: n }, (_, i) => pay(1_000, `pay-par-${String(i).padStart(4, '0')}`)),
    );
    expect(res.map((r) => r.status)).toEqual(Array(n).fill(201));
    expect(await fd.sql('SELECT 1 FROM folio')).toHaveLength(1);
    expect(await fd.sql('SELECT 1 FROM payment')).toHaveLength(n);
    expect((await folio()).balanceMinor).toBe(-20_000);
  });

  it.each([0, -1, 1.5, '100', 10_000_000_001])('amountMinor %p is 422 and writes nothing', async (amountMinor) => {
    const res = await fd.post(`/stays/${stayId}/folio/payments`, { method: 'cash', amountMinor, key: 'pay-bad-0001' });
    expect(res.status).toBe(422);
    expect(res.body.details).toEqual({ field: 'amountMinor' });
    expect(await fd.sql('SELECT 1 FROM payment')).toHaveLength(0);
  });

  it('the largest amount, 10_000_000_000, is accepted', async () => {
    expect((await pay(10_000_000_000, 'pay-maximum1')).status).toBe(201);
  });

  it('request fields are checked: each bad field is 422 naming it, and nothing is written', async () => {
    const charges = `/stays/${stayId}/folio/charges`;
    const payments = `/stays/${stayId}/folio/payments`;
    const ok = { kind: 'service', description: 'Mini bar', amountMinor: 1_000, key: 'charge-check1' };
    const cases: Array<[string, object, string?]> = [
      [charges, { ...ok, key: 'short' }],
      [charges, { ...ok, key: 'has space 1' }],
      [charges, { ...ok, key: undefined }],
      [charges, { ...ok, kind: 'accommodation' }],
      [charges, { ...ok, description: '' }],
      [charges, { ...ok, description: 'x'.repeat(201) }],
      [payments, { method: 'advance', amountMinor: 1_000, key: 'pay-check-01' }],
      [payments, { method: 'cash', amountMinor: 1_000, reference: 'x'.repeat(101), key: 'pay-check-02' }],
      [`/stays/${stayId}/folio/refunds`, { method: 'cash', amountMinor: 1_000, reason: '', key: 'refund-chk01' }, fd.manager],
      [`/stays/${stayId}/folio/refunds`, { method: 'cash', amountMinor: 1_000, reason: 'x'.repeat(501), key: 'refund-chk02' }, fd.manager],
    ];
    const answers = [];
    for (const [url, body, cookie] of cases) {
      const r = await fd.post(url, body, cookie);
      answers.push([r.status, r.body.details]);
    }
    expect(answers).toEqual([
      [422, { field: 'key' }],
      [422, { field: 'key' }],
      [422, { field: 'key' }],
      [422, { field: 'kind' }],
      [422, { field: 'description' }],
      [422, { field: 'description' }],
      [422, { field: 'method' }],
      [422, { field: 'reference' }],
      [422, { field: 'reason' }],
      [422, { field: 'reason' }],
    ]);
    expect(await fd.sql('SELECT 1 FROM folio')).toHaveLength(0);
  });

  it('an unknown stay, line or payment is 404', async () => {
    const none = '00000000-0000-4000-8000-000000000000';
    const res = [
      await fd.get(`/stays/${none}/folio`),
      await fd.get(`/stays/not-a-uuid/folio`),
      await fd.post(`/stays/${none}/folio/payments`, { method: 'cash', amountMinor: 1_000, key: 'pay-nostay-1' }),
      await fd.post(`/stays/${none}/folio/charges`, { kind: 'fee', description: 'x', amountMinor: 1_000, key: 'charge-nost1' }),
      await fd.post(`/folio-lines/${none}/reverse`, { reason: 'x', key: 'reverse-none1' }, fd.manager),
      await fd.post(`/payments/${none}/void`, { reason: 'x', key: 'void-none-001' }, fd.manager),
    ];
    expect(res.map((r) => [r.status, r.body.code])).toEqual([
      [404, 'stay_not_found'],
      [404, 'stay_not_found'],
      [404, 'stay_not_found'],
      [404, 'stay_not_found'],
      [404, 'line_not_found'],
      [404, 'payment_not_found'],
    ]);
  });

  it('every write is audited with its amount and business date', async () => {
    const line = (await charge(50_000, 'charge-aud-01')).body;
    await fd.post(`/folio-lines/${line.id}/reverse`, { reason: 'Pogrešan unos', key: 'reverse-aud-1' }, fd.manager);
    const p = (await pay(30_000, 'pay-aud-00001')).body;
    await fd.post(`/stays/${stayId}/folio/refunds`, { method: 'cash', amountMinor: 10_000, reason: 'Povraćaj', key: 'refund-aud-1' }, fd.manager);
    await fd.post(`/payments/${p.id}/void`, { reason: 'Greška', key: 'void-aud-0001' }, fd.manager);
    const rows = await fd.sql<{ action: string; amount: string; date: string }>(
      `SELECT action, after->>'amountMinor' AS amount, after->>'businessDate' AS date
         FROM audit_log WHERE action LIKE 'folio.%' ORDER BY id`,
    );
    expect(rows).toEqual([
      { action: 'folio.charge', amount: '50000', date: '2026-11-02' },
      { action: 'folio.reverse', amount: '-50000', date: '2026-11-02' },
      { action: 'folio.pay', amount: '30000', date: '2026-11-02' },
      { action: 'folio.refund', amount: '-10000', date: '2026-11-02' },
      { action: 'folio.void', amount: '-30000', date: '2026-11-02' },
    ]);
  });

  it('the database refuses to change or delete a line or a payment', async () => {
    await charge(50_000, 'charge-0003');
    await pay(10_000, 'pay-00000003');
    await expect(fd.sql('UPDATE folio_line SET amount_minor = 1')).rejects.toThrow(/append_only/);
    await expect(fd.sql('DELETE FROM payment')).rejects.toThrow(/append_only/);
  });

  it('the database refuses a second reversal of a line and a second void of a payment', async () => {
    const line = (await charge(50_000, 'charge-0006')).body;
    const p = (await pay(10_000, 'pay-00000008')).body;
    await fd.post(`/folio-lines/${line.id}/reverse`, { reason: 'x', key: 'reverse-db-01' }, fd.manager);
    await fd.post(`/payments/${p.id}/void`, { reason: 'x', key: 'void-db-00001' }, fd.manager);
    await expect(
      fd.sql(
        `INSERT INTO folio_line (property_id, folio_id, kind, description, amount_minor, business_date, source_type, reverses_line_id)
         SELECT property_id, folio_id, 'correction', 'x', 1, business_date, 'reversal', id FROM folio_line WHERE id = $1`,
        [line.id],
      ),
    ).rejects.toMatchObject({ constraint: 'folio_line_reverses_once' });
    await expect(
      fd.sql(
        `INSERT INTO payment (property_id, folio_id, method, amount_minor, business_date, reverses_payment_id, idempotency_key, request_hash)
         SELECT property_id, folio_id, method, 1, business_date, id, 'db-void-2', 'h' FROM payment WHERE id = $1`,
        [p.id],
      ),
    ).rejects.toMatchObject({ constraint: 'payment_reverses_once' });
  });

  it('in safe mode payments and GET work; charges are safe_mode_blocked', async () => {
    fd.shiftLicence(400 * 86_400_000);
    expect((await pay(10_000, 'pay-00000004')).status).toBe(201);
    expect((await fd.get(`/stays/${stayId}/folio`)).status).toBe(200);
    const res = await charge(10_000, 'charge-0004');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('safe_mode_blocked');
  });

  describe('postNight (night audit and check-out, Tasks 5-6)', () => {
    const post = (night: string, source: 'night_audit' | 'check_out' | 'no_show' = 'night_audit') => {
      const days = fd.app.get(BusinessDayService);
      const svc = fd.app.get(FolioService);
      return fd.ta.testDb.db.transaction(async (tx) => {
        const businessDate = await days.lockOpen(tx, pid, 'share');
        const f = await svc.ensureFolio(tx, pid, stayId);
        return svc.postNight(tx, pid, f.id, { id: stayId }, night, businessDate, source);
      });
    };

    it('posts a night once at its agreed price and the accommodation VAT; the view stops listing it', async () => {
      await fd.put('/settings/business', { accommodationVatBp: 1000 });
      expect(await post('2026-11-02')).toBe(true);
      expect(await post('2026-11-02')).toBe(false);
      expect(await post('2026-11-03', 'check_out')).toBe(true);
      const lines = await fd.sql(
        `SELECT kind, description, amount_minor::text AS amount, vat_rate_bp, night::text AS night, business_date::text AS bd,
                source_type, source_id
           FROM folio_line ORDER BY night`,
      );
      expect(lines).toEqual([
        { kind: 'accommodation', description: 'Smeštaj 2.11.2026', amount: '1000000', vat_rate_bp: 1000, night: '2026-11-02', bd: '2026-11-02', source_type: 'night_audit', source_id: '2026-11-02' },
        { kind: 'accommodation', description: 'Smeštaj 3.11.2026', amount: '1000000', vat_rate_bp: 1000, night: '2026-11-03', bd: '2026-11-02', source_type: 'check_out', source_id: stayId },
      ]);
      const f = await folio();
      expect(f).toMatchObject({ chargesMinor: 2_000_000, balanceMinor: 2_000_000, unpostedNights: [] });
    });

    it('a night priced 0 is not posted; a night without a stay_night row is a NightWithoutPrice error', async () => {
      await fd.sql(`UPDATE stay_night SET price_minor = 0 WHERE stay_id = $1 AND day = '2026-11-02'`, [stayId]);
      expect(await post('2026-11-02')).toBe(false);
      await fd.sql(`DELETE FROM stay_night WHERE stay_id = $1 AND day = '2026-11-03'`, [stayId]);
      const err = await post('2026-11-03').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NightWithoutPrice);
      expect(err).toMatchObject({ stayId, night: '2026-11-03' });
      expect(await fd.sql('SELECT 1 FROM folio_line')).toHaveLength(0);
      // 11-02 at 0 is never posted, so it is not listed as unposted either; 11-03 has no row.
      expect((await folio()).unpostedNights).toEqual([]);
    });

    // Ruling 31: a night goes only into the open folio of its own stay. One fixture per predicate.
    const postInto = (folioOf: string, night: string) => {
      const days = fd.app.get(BusinessDayService);
      const svc = fd.app.get(FolioService);
      return fd.ta.testDb.db.transaction(async (tx) => {
        const businessDate = await days.lockOpen(tx, pid, 'share');
        const f = await svc.ensureFolio(tx, pid, folioOf);
        return svc.postNight(tx, pid, f.id, { id: stayId }, night, businessDate, 'check_out');
      });
    };

    it("postNight refuses another stay's folio: FolioNotOpen and no line", async () => {
      const other = await fd.bookStay({ typeId, planId }, '2026-11-02', '2026-11-03');
      const err = await postInto(other.stayId, '2026-11-02').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FolioNotOpen);
      expect(err).toMatchObject({ stayId });
      expect(await fd.sql('SELECT 1 FROM folio_line')).toHaveLength(0);
    });

    it('postNight refuses a closed folio of the stay: FolioNotOpen and no line', async () => {
      await pay(1_000, 'pay-opens-folio');
      await fd.sql(`UPDATE folio SET status = 'closed', closed_at = now() WHERE stay_id = $1`, [stayId]);
      const err = await postInto(stayId, '2026-11-02').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FolioNotOpen);
      expect(await fd.sql('SELECT 1 FROM folio_line')).toHaveLength(0);
    });
  });
});
