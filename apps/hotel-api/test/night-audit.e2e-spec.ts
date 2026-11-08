import { ActivationService } from '../src/licensing/activation.service';
import { BusinessDayService } from '../src/business-day/business-day.service';
import { NightAuditScheduler } from '../src/business-day/night-audit.scheduler';
import { NightAuditService } from '../src/business-day/night-audit.service';
import { PropertyContext } from '../src/common/property-context';
import { LicenceService } from '../src/licensing/licence.service';
import { startFrontDesk, type FrontDesk } from './front-desk';
import { occupyNights } from './upgrade';

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

describe('night audit (e2e)', () => {
  let fd: FrontDesk;
  let typeId: string;
  let planId: string;
  let unitIds: string[];

  beforeAll(async () => {
    fd = await startFrontDesk();
  });
  beforeEach(async () => {
    await fd.reset();
    ({ typeId, planId, unitIds } = await fd.pricedType('DBL', 3));
  });
  afterAll(() => fd.close());

  // fd.inHouse (preflight F36); `unit` is the index into the type's units.
  const inHouse = (unit: number, arrival: string, departure: string) =>
    fd.inHouse({ typeId, planId, unitId: unitIds[unit] }, arrival, departure);
  const close = (day: string, cookie?: string) => fd.post('/business-day/close', { day }, cookie);
  const nightLines = () =>
    fd.sql<{ night: string; amount: string; business_date: string; source_type: string }>(
      `SELECT night::text AS night, amount_minor::text AS amount, business_date::text AS business_date, source_type
         FROM folio_line WHERE kind = 'accommodation' ORDER BY night`,
    );
  const openDays = () => fd.sql<{ day: string }>(`SELECT day::text AS day FROM business_day WHERE status = 'open'`);
  /** Opens the property's today through lockOpen, as a writing transaction would (preflight F2). */
  const openToday = async () => {
    const pid = await fd.app.get(PropertyContext).id();
    const days = fd.app.get(BusinessDayService);
    await fd.ta.testDb.db.transaction((tx) => days.lockOpen(tx, pid, 'share'));
  };

  // Note: a stay leaving on 2026-11-03 does not block closing 2026-11-02; only departure <= D blocks.
  it('closing posts each in-house night once, opens the next day and stores the report', async () => {
    await inHouse(0, '2026-11-02', '2026-11-04');
    await inHouse(1, '2026-11-02', '2026-11-03');
    const res = await close('2026-11-02');
    expect(res.status).toBe(200);
    expect(res.body.alreadyClosed).toBe(false);
    expect(res.body.report).toMatchObject({
      day: '2026-11-02',
      mode: 'manual',
      arrivals: 2,
      inHouse: 2,
      postedNights: 2,
      noShows: [],
      roomRevenueMinor: 2_000_000,
      chargesByKindMinor: { accommodation: 2_000_000 },
    });
    expect(await nightLines()).toEqual([
      { night: '2026-11-02', amount: '1000000', business_date: '2026-11-02', source_type: 'night_audit' },
      { night: '2026-11-02', amount: '1000000', business_date: '2026-11-02', source_type: 'night_audit' },
    ]);
    expect((await fd.get('/business-day')).body).toMatchObject({ day: '2026-11-03', started: true });
    const [row] = await fd.sql<{ status: string; close_mode: string; closed_at: Date; last_auto_error: unknown; report: unknown }>(
      `SELECT status, close_mode, closed_at, last_auto_error, report FROM business_day WHERE day = '2026-11-02'`,
    );
    expect(row).toMatchObject({ status: 'closed', close_mode: 'manual', last_auto_error: null, report: res.body.report });
    expect(new Date(row.closed_at).toISOString()).toBe('2026-11-02T08:00:00.000Z'); // CLOCK, not now()
    expect(await fd.sql(`SELECT entity_id, after->>'next' AS next FROM audit_log WHERE action = 'business_day.close'`)).toEqual([
      { entity_id: '2026-11-02', next: '2026-11-03' },
    ]);
  });

  it('closing the same day again returns the stored report and posts nothing', async () => {
    await inHouse(0, '2026-11-02', '2026-11-04');
    const first = await close('2026-11-02');
    await fd.travel(new Date('2026-11-03T08:00:00Z'));
    const second = await close('2026-11-02');
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ alreadyClosed: true, report: first.body.report });
    expect(await nightLines()).toHaveLength(1);
    expect(await openDays()).toEqual([{ day: '2026-11-03' }]);
  });

  it('two closes in parallel: one posts, both answer the same report', async () => {
    await inHouse(0, '2026-11-02', '2026-11-04');
    // Both wait on the held day and race for it at once (Ruling 27).
    const [a, b] = await fd.raceUnderHeldDay(2, () => [close('2026-11-02'), close('2026-11-02', fd.manager)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.alreadyClosed, b.body.alreadyClosed].sort()).toEqual([false, true]);
    expect(a.body.report).toEqual(b.body.report);
    expect(await nightLines()).toHaveLength(1);
  });

  it('a guest due to leave who is still in house blocks the close, named in the error', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-03');
    await close('2026-11-02');
    await fd.travel(new Date('2026-11-03T22:00:00Z'));
    const res = await close('2026-11-03');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('close_blocked');
    expect(res.body.details.departures).toEqual([
      { stayId: s.stayId, reservationId: s.reservationId, number: expect.any(String), unitName: 'DBL-1', departure: '2026-11-03' },
    ]);
    expect((await fd.get('/business-day')).body.day).toBe('2026-11-03');
    expect(await nightLines()).toHaveLength(1); // only the night of 11-02
  });

  it('a future day cannot be closed', async () => {
    await close('2026-11-02');
    const res = await close('2026-11-03'); // the clock still says 2026-11-02
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'business_day_in_future', details: { day: '2026-11-03', today: '2026-11-02' } });
    expect(await openDays()).toEqual([{ day: '2026-11-03' }]);
  });

  it('a day other than the open one is 409 business_day_mismatch', async () => {
    const res = await close('2026-11-05');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'business_day_mismatch', details: { open: '2026-11-02' } });
    expect(await fd.sql('SELECT 1 FROM business_day')).toHaveLength(0); // the day lockOpen opened rolled back
  });

  it('a missing or malformed day is 422 naming day and writes nothing', async () => {
    const seen = [];
    for (const body of [{}, { day: '2026-13-01' }, { day: '2.11.2026' }, { day: 20261102 }]) {
      const res = await fd.post('/business-day/close', body);
      seen.push({ status: res.status, details: res.body.details });
    }
    expect(seen).toEqual(Array.from({ length: 4 }, () => ({ status: 422, details: { field: 'day' } })));
    expect(await fd.sql('SELECT 1 FROM business_day')).toHaveLength(0);
  });

  it('an expected stay whose arrival day closes becomes no_show and frees its unit and nights', async () => {
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-02', '2026-11-04');
    const res = await close('2026-11-02');
    expect(res.body.report.noShows).toEqual([
      { stayId: b.stayId, number: expect.any(String), guest: 'Petar Petrović', arrival: '2026-11-02', chargedMinor: 0 },
    ]);
    expect(res.body.report.postedNights).toBe(0);
    expect(await fd.sql('SELECT status FROM stay WHERE id = $1', [b.stayId])).toEqual([{ status: 'no_show' }]);
    expect(await fd.sql('SELECT status, version FROM reservation WHERE id = $1', [b.reservationId])).toEqual([
      { status: 'no_show', version: b.version + 1 },
    ]);
    expect(
      await fd.sql(`SELECT day::text AS day, sold FROM inventory_day WHERE scope_id = $1 AND day < '2026-11-04' ORDER BY day`, [typeId]),
    ).toEqual([
      { day: '2026-11-02', sold: 0 },
      { day: '2026-11-03', sold: 0 },
    ]);
    expect(await fd.sql('SELECT 1 FROM folio')).toHaveLength(0); // no charge, no folio
    expect(await fd.sql(`SELECT entity_id FROM audit_log WHERE action = 'stay.no_show'`)).toEqual([{ entity_id: b.stayId }]);
    // The calendar no longer draws it (preflight F12); the unit books again.
    await fd.travel(new Date('2026-11-03T08:00:00Z'));
    const cal = await fd.get('/calendar?from=2026-11-03&to=2026-11-05');
    expect(cal.status).toBe(200);
    expect(cal.body.units.find((u: { id: string }) => u.id === unitIds[0]).bars).toEqual([]);
    expect((await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-03', '2026-11-04')).stayId).toBeDefined();
  });

  it('with no_show_charge first_night the first night is posted to the no-show folio', async () => {
    await fd.put('/settings/business', { noShowCharge: 'first_night' });
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-02', '2026-11-04');
    const res = await close('2026-11-02');
    expect(res.body.report.noShows[0].chargedMinor).toBe(1_000_000);
    expect(res.body.report).toMatchObject({ postedNights: 1, roomRevenueMinor: 1_000_000, inHouse: 0 });
    expect((await fd.get(`/stays/${b.stayId}/folio`)).body.lines).toEqual([
      expect.objectContaining({ kind: 'accommodation', night: '2026-11-02', sourceType: 'no_show', amountMinor: 1_000_000 }),
    ]);
  });

  it('one stay of a two-stay reservation is a no-show: the reservation stays confirmed, version + 1', async () => {
    const res = await fd.post('/reservations', {
      source: 'front_desk',
      holder: { firstName: 'Ana', lastName: 'Anić' },
      stays: [
        { unitId: unitIds[0], arrival: '2026-11-02', departure: '2026-11-03', adults: 1, children: 0, ratePlanId: planId },
        { unitId: unitIds[1], arrival: '2026-11-05', departure: '2026-11-06', adults: 1, children: 0, ratePlanId: planId },
      ],
    });
    expect(res.status).toBe(201);
    const id = res.body.reservationId as string;
    const [{ version }] = await fd.sql<{ version: number }>('SELECT version FROM reservation WHERE id = $1', [id]);
    const closed = await close('2026-11-02');
    expect(closed.body.report.noShows).toEqual([expect.objectContaining({ guest: 'Ana Anić', arrival: '2026-11-02' })]);
    expect(await fd.sql('SELECT arrival::text AS arrival, status FROM stay WHERE reservation_id = $1 ORDER BY arrival', [id])).toEqual([
      { arrival: '2026-11-02', status: 'no_show' },
      { arrival: '2026-11-05', status: 'expected' },
    ]);
    expect(await fd.sql('SELECT status, version FROM reservation WHERE id = $1', [id])).toEqual([
      { status: 'confirmed', version: version + 1 },
    ]);
  });

  it('a requested reservation is not counted or marked as a no-show', async () => {
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-02', '2026-11-04');
    await fd.sql(`UPDATE reservation SET status = 'requested' WHERE id = $1`, [b.reservationId]);
    expect((await fd.get('/business-day')).body.pending.noShows).toBe(0);
    const res = await close('2026-11-02');
    expect(res.body.report.noShows).toEqual([]);
    expect(await fd.sql('SELECT status FROM stay WHERE id = $1', [b.stayId])).toEqual([{ status: 'expected' }]);
    expect(await fd.sql('SELECT status, version FROM reservation WHERE id = $1', [b.reservationId])).toEqual([
      { status: 'requested', version: b.version },
    ]);
  });

  it('an old expected stay arriving before the open day (staging after the migration) becomes a no-show at the first close', async () => {
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-02', '2026-11-04');
    // As seedPhase1a leaves it: arrival in the past, its nights priced and sold (preflight F4).
    await fd.sql(`UPDATE stay SET arrival = '2026-10-30' WHERE id = $1`, [b.stayId]);
    await occupyNights(fd.sql, b.stayId, '2026-10-30', '2026-11-02');
    const res = await close('2026-11-02');
    expect(res.status).toBe(200);
    expect(res.body.report.noShows).toEqual([expect.objectContaining({ stayId: b.stayId, arrival: '2026-10-30' })]);
    expect(await fd.sql(`SELECT sum(sold)::int AS sold FROM inventory_day WHERE scope_id = $1`, [typeId])).toEqual([{ sold: 0 }]);
    const cal = await fd.get('/calendar?from=2026-10-30&to=2026-11-05');
    expect(cal.body.units.find((u: { id: string }) => u.id === unitIds[0]).bars).toEqual([]);
  });

  it('cancel and close in parallel on one expected stay: cancelled or no_show, sold never negative, never a 500', async () => {
    // cancel never takes the business day, so the race is on the reservation row: a held
    // transaction locks it, the two requests queue behind it in alternating order, then it
    // is released (Rulings 27, 27a, 28).
    const outcomes = new Set<string>();
    for (let k = 0; k < 20; k++) {
      const day = addDays('2026-11-02', k);
      await fd.travel(new Date(`${day}T08:00:00Z`)); // each close moves the open day by one
      const b = await fd.bookStay({ typeId, planId }, day, addDays(day, 1));
      const cancel = () => fd.post(`/reservations/${b.reservationId}/cancel`, { version: b.version });
      const closing = () => close(day);
      const [first, second] = k % 2 === 0 ? [cancel, closing] : [closing, cancel];
      const [r1, r2] = await queuedBehindReservation(b.reservationId, first, second);
      const [c, x] = k % 2 === 0 ? [r1, r2] : [r2, r1];
      const [{ status }] = await fd.sql<{ status: string }>('SELECT status FROM stay WHERE id = $1', [b.stayId]);
      // The night of this stay: given back exactly once, whichever request won.
      const [{ sold }] = await fd.sql<{ sold: number }>(
        `SELECT sold FROM inventory_day WHERE scope_id = $1 AND day = $2::date`,
        [typeId, day],
      );
      const seen = { k, close: x.status, cancel: c.status, status, sold };
      expect(seen).toEqual({
        k,
        close: 200,
        cancel: status === 'cancelled' ? 200 : 409,
        status: expect.stringMatching(/^(cancelled|no_show)$/),
        sold: 0,
      });
      outcomes.add(status);
    }
    expect([...outcomes].sort()).toEqual(['cancelled', 'no_show']); // both branches were taken
  }, 120_000);

  /** Holds the reservation row, fires `first`, waits until it waits, fires `second`, waits again, releases. */
  async function queuedBehindReservation<A, B>(id: string, first: () => PromiseLike<A>, second: () => PromiseLike<B>): Promise<[A, B]> {
    const holder = await fd.ta.testDb.pool.connect();
    let a: Promise<A> | null = null;
    let b: Promise<B> | null = null;
    let waitError: unknown = null;
    try {
      await holder.query('BEGIN');
      const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await holder.query('SELECT 1 FROM reservation WHERE id = $1 FOR UPDATE', [id]);
      const waiting = async (n: number) => {
        const deadline = Date.now() + 5_000;
        for (;;) {
          const [{ w }] = await fd.sql<{ w: number }>(
            `SELECT count(*)::int AS w FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`,
            [rows[0].pid],
          );
          if (w >= n) return;
          if (Date.now() > deadline) throw new Error(`barrier: only ${w} of ${n} requests waited on the reservation`);
          await new Promise<void>((r) => setTimeout(r, 20));
        }
      };
      a = Promise.resolve(first());
      await waiting(1);
      b = Promise.resolve(second());
      await waiting(2);
    } catch (err) {
      waitError = err;
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    const results = (await Promise.all([a, b])) as [A, B];
    if (waitError) throw waitError;
    return results;
  }

  it('a payment waiting on the close lands on the next business date', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-04');
    const [c, p] = await fd.raceUnderHeldDay(2, () => [
      close('2026-11-02'),
      fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'cash', amountMinor: 1_000, key: 'pay-wait-0001' }),
    ]);
    expect(c.status).toBe(200);
    expect(p.status).toBe(201);
    // The oracle is the close's report (an immutable snapshot), not the payment service.
    const inReport = c.body.report.paymentsByMethodMinor.cash ?? 0;
    expect(p.body.businessDate).toBe(inReport === 1_000 ? '2026-11-02' : '2026-11-03');
  });

  it('a close waits for a posting that holds the day FOR SHARE, and reports what it posted', async () => {
    // A payment in flight, held open by the test: it took the day FOR SHARE (lock order 0),
    // read business date 2026-11-02 and wrote its row. The close must wait for it (FOR UPDATE)
    // and then count it; a close that did not wait would report the day without it.
    // The payment is on the folio of a later stay that the close never locks (its insert
    // holds that folio row FOR KEY SHARE, which would make a close posting to it wait anyway).
    await inHouse(0, '2026-11-02', '2026-11-04');
    const s = await fd.bookStay({ typeId, planId, unitId: unitIds[1] }, '2026-11-05', '2026-11-06');
    expect((await fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'card', amountMinor: 500, key: 'pay-deposit-1' })).status).toBe(201);
    const pid = await fd.app.get(PropertyContext).id();
    const [{ id: folioId }] = await fd.sql<{ id: string }>('SELECT id FROM folio WHERE stay_id = $1', [s.stayId]);
    const holder = await fd.ta.testDb.pool.connect();
    let closing: Promise<{ status: number; body: { report: { paymentsByMethodMinor: Record<string, number> } } }> | null = null;
    let waited = false;
    try {
      await holder.query('BEGIN');
      const { rows } = await holder.query<{ day: string }>(
        `SELECT day::text AS day FROM business_day WHERE property_id = $1 AND status = 'open' FOR SHARE`,
        [pid],
      );
      await holder.query(
        `INSERT INTO payment (property_id, folio_id, method, amount_minor, business_date, idempotency_key, request_hash)
         VALUES ($1, $2, 'cash', 1000, $3::date, 'held-pay-0001', 'held')`,
        [pid, folioId, rows[0].day],
      );
      let done = false;
      closing = Promise.resolve(close('2026-11-02')).then((r) => {
        done = true;
        return r;
      });
      const deadline = Date.now() + 3_000;
      while (!done && Date.now() < deadline) {
        const [{ w }] = await fd.sql<{ w: number }>(
          `SELECT count(*)::int AS w FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if (w >= 1) {
          waited = true;
          break;
        }
        await new Promise<void>((r) => setTimeout(r, 20));
      }
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    const res = await closing!;
    expect({ waited, status: res.status, cash: res.body.report.paymentsByMethodMinor.cash }).toEqual({
      waited: true,
      status: 200,
      cash: 1000,
    });
  });

  it('a night that cannot be posted (no stay_night row) is 409 close_failed and the day stays open', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-04');
    await fd.sql(`DELETE FROM stay_night WHERE stay_id = $1 AND day = '2026-11-02'`, [s.stayId]);
    const res = await close('2026-11-02');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'close_failed', details: { stayId: s.stayId, night: '2026-11-02' } });
    expect(await openDays()).toEqual([{ day: '2026-11-02' }]);
    expect(await fd.sql('SELECT 1 FROM folio_line')).toHaveLength(0);
  });

  it('an in-house stay with a closed folio is 409 close_failed, not a 500, and the day stays open', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-04');
    await fd.sql(`UPDATE folio SET status = 'closed', closed_at = '2026-11-02T08:00:00Z' WHERE stay_id = $1`, [s.stayId]);
    const res = await close('2026-11-02');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'close_failed', details: { stayId: s.stayId, night: '2026-11-02' } });
    expect(await openDays()).toEqual([{ day: '2026-11-02' }]);
  });

  it('an in-house stay that has not arrived by D (data only, check-in cannot make it) gets no night', async () => {
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-03', '2026-11-05');
    await fd.sql(`UPDATE stay SET status = 'in_house' WHERE id = $1`, [b.stayId]);
    const res = await close('2026-11-02');
    expect(res.status).toBe(200);
    expect(res.body.report).toMatchObject({ inHouse: 0, postedNights: 0 });
    expect(await nightLines()).toEqual([]);
  });

  it('the report counts arrivals, departures, revenue and payments of D', async () => {
    const a = await inHouse(0, '2026-11-02', '2026-11-03');
    const c = await inHouse(1, '2026-11-02', '2026-11-03');
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[2] }, '2026-11-02', '2026-11-03');
    await fd.post(`/stays/${c.stayId}/folio/payments`, { method: 'cash', amountMinor: 1_000_000, key: 'pay-report-01' });
    expect((await fd.post(`/stays/${c.stayId}/check-out`, { version: c.version })).status).toBe(200);
    const res = await close('2026-11-02');
    expect(res.body.report).toMatchObject({
      arrivals: 2,
      departures: 1,
      inHouse: 1,
      postedNights: 1, // a's night; c's was posted by the check-out
      roomRevenueMinor: 2_000_000,
      chargesByKindMinor: { accommodation: 2_000_000 },
      paymentsByMethodMinor: { cash: 1_000_000 },
      closedBy: expect.any(String),
    });
    expect(res.body.report.noShows).toEqual([expect.objectContaining({ stayId: b.stayId })]);
    expect(a.stayId).toBeDefined();
  });

  it('a correction counts against the kind it reverses (preflight F26)', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-05');
    await close('2026-11-02');
    await fd.travel(new Date('2026-11-03T08:00:00Z'));
    const [line] = await fd.sql<{ id: string }>(`SELECT id FROM folio_line WHERE night = '2026-11-02'`);
    expect((await fd.post(`/folio-lines/${line.id}/reverse`, { reason: 'Gost nije spavao', key: 'rev-night-01' }, fd.manager)).status).toBe(201);
    const charge = { kind: 'service', description: 'Mini bar', amountMinor: 5_000, key: 'chg-minibar-1' };
    expect((await fd.post(`/stays/${s.stayId}/folio/charges`, charge)).status).toBe(201);
    await fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'card', amountMinor: 2_000, key: 'pay-card-0001' });
    const res = await close('2026-11-03');
    expect(res.body.report).toMatchObject({
      roomRevenueMinor: 0, // the night of 11-03 posted, the night of 11-02 reversed, both on 11-03
      chargesByKindMinor: { accommodation: 0, service: 5_000 },
      paymentsByMethodMinor: { card: 2_000 },
      postedNights: 1,
    });
    expect(Object.keys(res.body.report.chargesByKindMinor).sort()).toEqual(['accommodation', 'service']);
  });

  it('after the close of 2026-11-02 a stay arriving 2026-11-02 is 422 arrival_before_business_date (preflight F3)', async () => {
    await close('2026-11-02');
    const book = (arrival: string, departure: string) =>
      fd.post('/reservations', {
        source: 'front_desk',
        holder: { firstName: 'Petar', lastName: 'Petrović' },
        stays: [{ unitTypeId: typeId, arrival, departure, adults: 2, children: 0, ratePlanId: planId }],
      });
    const late = await book('2026-11-02', '2026-11-03');
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('arrival_before_business_date');
    expect((await book('2026-11-03', '2026-11-04')).status).toBe(201);
  });

  it('auto close: not due before the time, closes after it, records the reason when blocked', async () => {
    const scheduler = fd.app.get(NightAuditScheduler);
    expect(await scheduler.runOnce()).toBe('disabled');
    await fd.put('/settings/business', { autoCloseTime: '03:00' });
    await openToday(); // 2026-11-02 is open while the clock still says NOW (preflight F2)
    fd.setNow(new Date('2026-11-03T01:59:00Z')); // 02:59 in Belgrade
    expect(await scheduler.runOnce()).toBe('not_due');
    fd.setNow(new Date('2026-11-03T02:00:00Z'));
    expect(await scheduler.runOnce()).toBe('closed');
    await fd.travel(new Date('2026-11-03T02:00:00Z'));
    const day = await fd.get('/business-days/2026-11-02');
    expect(day.body).toMatchObject({ day: '2026-11-02', mode: 'auto', closedBy: null, report: { mode: 'auto', closedBy: null } });

    const s = await inHouse(0, '2026-11-03', '2026-11-04');
    fd.setNow(new Date('2026-11-04T02:00:00Z'));
    expect(await scheduler.runOnce()).toBe('closed'); // closes 11-03, posts the night
    expect(await nightLines()).toHaveLength(1);
    await fd.travel(new Date('2026-11-05T02:00:00Z'));
    expect(await scheduler.runOnce()).toBe('blocked'); // 11-04: the guest due to leave is still in house
    const view = (await fd.get('/business-day')).body;
    expect(view.day).toBe('2026-11-04');
    expect(view.lastAutoError).toEqual({
      at: '2026-11-05T02:00:00.000Z',
      code: 'close_blocked',
      details: { departures: [expect.objectContaining({ stayId: s.stayId })] },
    });

    // Once the guest leaves the next tick closes the day and the error goes with it.
    expect((await fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'cash', amountMinor: 1_000_000, key: 'pay-auto-0001' })).status).toBe(201);
    expect((await fd.post(`/stays/${s.stayId}/check-out`, { version: s.version })).status).toBe(200);
    expect(await scheduler.runOnce()).toBe('closed');
    expect(await fd.sql(`SELECT last_auto_error FROM business_day WHERE day = '2026-11-04'`)).toEqual([{ last_auto_error: null }]);
  });

  it('auto close: two overlapping runs close once', async () => {
    await fd.put('/settings/business', { autoCloseTime: '03:00' });
    await openToday();
    fd.setNow(new Date('2026-11-03T02:00:00Z'));
    const spy = jest.spyOn(fd.app.get(NightAuditService), 'close');
    try {
      const scheduler = fd.app.get(NightAuditScheduler);
      expect(await Promise.all([scheduler.runOnce(), scheduler.runOnce()])).toEqual(['closed', 'closed']);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('auto close: off without the hotel.folio module and before setup', async () => {
    await fd.reset({ modules: ['hotel.core'] });
    const pid = await fd.app.get(PropertyContext).id();
    await fd.sql(`INSERT INTO property_settings (property_id, auto_close_time) VALUES ($1, '03:00')`, [pid]);
    await openToday();
    fd.setNow(new Date('2026-11-03T02:00:00Z'));
    const scheduler = fd.app.get(NightAuditScheduler);
    expect(await scheduler.runOnce()).toBe('disabled');
    expect(await openDays()).toEqual([{ day: '2026-11-02' }]);

    // An activated installation whose owner setup has not run: no property yet.
    await fd.ta.reset();
    await fd.app.get(ActivationService).activate(
      fd.fake.issueCode({ licence: { modules: ['hotel.core', 'hotel.folio'], limits: { rooms: 20, users: 10 } } }),
    );
    await fd.app.get(LicenceService).reload();
    expect(await fd.sql('SELECT 1 FROM property')).toHaveLength(0);
    expect(await scheduler.runOnce()).toBe('disabled');
  });

  it('GET /business-day shows blockers and pending before the close', async () => {
    const a = await inHouse(0, '2026-11-02', '2026-11-03');
    const c = await inHouse(1, '2026-11-02', '2026-11-03');
    await fd.bookStay({ typeId, planId, unitId: unitIds[2] }, '2026-11-02', '2026-11-04');
    await fd.post(`/stays/${c.stayId}/folio/payments`, { method: 'cash', amountMinor: 1_000_000, key: 'pay-pending-1' });
    await fd.post(`/stays/${c.stayId}/check-out`, { version: c.version });
    const before = (await fd.get('/business-day')).body;
    expect(before).toMatchObject({
      day: '2026-11-02',
      blockers: [],
      pending: { arrivals: 2, departures: 1, inHouse: 1, nightsToPost: 1, noShows: 1 },
    });
    expect((await close('2026-11-02')).status).toBe(200);
    await fd.travel(new Date('2026-11-03T22:00:00Z'));
    const after = (await fd.get('/business-day')).body;
    expect(after).toMatchObject({
      day: '2026-11-03',
      pending: { arrivals: 0, departures: 0, inHouse: 1, nightsToPost: 0, noShows: 0 },
    });
    expect(after.blockers).toEqual([
      { stayId: a.stayId, reservationId: a.reservationId, number: expect.any(String), unitName: 'DBL-1', departure: '2026-11-03' },
    ]);
  });

  it('GET /business-days lists the closed days of the range with their revenue; GET /business-days/:day has the report', async () => {
    await inHouse(0, '2026-11-02', '2026-11-05');
    await fd.bookStay({ typeId, planId, unitId: unitIds[1] }, '2026-11-02', '2026-11-03');
    const first = await close('2026-11-02');
    await fd.travel(new Date('2026-11-03T08:00:00Z'));
    await close('2026-11-03');
    const list = await fd.get('/business-days?from=2026-11-01&to=2026-11-04');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([
      { day: '2026-11-02', closedAt: '2026-11-02T08:00:00.000Z', mode: 'manual', roomRevenueMinor: 1_000_000, noShows: 1 },
      { day: '2026-11-03', closedAt: '2026-11-03T08:00:00.000Z', mode: 'manual', roomRevenueMinor: 1_000_000, noShows: 0 },
    ]);
    expect((await fd.get('/business-days?from=2026-11-03&to=2026-11-10')).body.map((d: { day: string }) => d.day)).toEqual([
      '2026-11-03',
    ]);
    expect((await fd.get('/business-days?from=2026-11-01&to=2026-11-03')).body.map((d: { day: string }) => d.day)).toEqual([
      '2026-11-02',
    ]);
    const day = await fd.get('/business-days/2026-11-02', fd.manager);
    expect(day.status).toBe(200);
    expect(day.body).toEqual({
      day: '2026-11-02',
      closedAt: '2026-11-02T08:00:00.000Z',
      closedBy: first.body.report.closedBy,
      mode: 'manual',
      report: first.body.report,
    });
  });

  it('GET /business-days: a bad or too long range is 422; an open, unknown or malformed day is 404', async () => {
    await openToday();
    const seen = [];
    for (const q of ['', '?from=2026-11-01', '?from=2026-11-05&to=2026-11-01', '?from=x&to=2026-11-01']) {
      const res = await fd.get(`/business-days${q}`);
      seen.push({ q, status: res.status, code: res.body.code });
    }
    expect(seen.every((s) => s.status === 422 && s.code === 'validation_failed')).toBe(true);
    expect((await fd.get('/business-days?from=2026-11-01&to=2027-01-02')).status).toBe(200); // 62 days
    const long = await fd.get('/business-days?from=2026-11-01&to=2027-01-03'); // 63 days
    expect(long.status).toBe(422);
    expect(long.body).toMatchObject({ code: 'range_too_long', details: { max: 62 } });
    for (const day of ['2026-11-02', '2026-10-01', 'yesterday']) {
      const res = await fd.get(`/business-days/${day}`);
      expect({ day, status: res.status, code: res.body.code }).toEqual({ day, status: 404, code: 'business_day_not_found' });
    }
  });

  it('a receptionist can close the day; housekeeping cannot reach the night audit routes', async () => {
    const seen = [];
    for (const [route, res] of [
      ['POST /business-day/close', await close('2026-11-02', fd.housekeeping)],
      ['GET /business-days', await fd.get('/business-days?from=2026-11-01&to=2026-11-04', fd.housekeeping)],
      ['GET /business-days/:day', await fd.get('/business-days/2026-11-02', fd.housekeeping)],
    ] as const) {
      seen.push({ route, status: res.status, code: res.body.code });
    }
    expect(seen).toEqual(
      ['POST /business-day/close', 'GET /business-days', 'GET /business-days/:day'].map((route) => ({
        route,
        status: 403,
        code: 'forbidden_role',
      })),
    );
    expect(await fd.sql('SELECT 1 FROM business_day')).toHaveLength(0);
    expect((await close('2026-11-02', fd.receptionist)).status).toBe(200);
  });

  it('the night audit routes are hotel.folio: a licence with hotel.core only refuses them', async () => {
    await fd.reset({ modules: ['hotel.core'] });
    const seen = [];
    for (const [route, res] of [
      ['POST /business-day/close', await close('2026-11-02')],
      ['GET /business-days', await fd.get('/business-days?from=2026-11-01&to=2026-11-04')],
      ['GET /business-days/:day', await fd.get('/business-days/2026-11-02')],
    ] as const) {
      seen.push({ route, status: res.status, code: res.body.code });
    }
    expect(seen).toEqual(
      ['POST /business-day/close', 'GET /business-days', 'GET /business-days/:day'].map((route) => ({
        route,
        status: 403,
        code: 'module_not_licensed',
      })),
    );
  });

  it('in safe mode the close works and posts the night', async () => {
    await inHouse(0, '2026-11-02', '2026-11-04');
    fd.shiftLicence(400 * DAY_MS);
    const res = await close('2026-11-02');
    expect(res.status).toBe(200);
    expect(await nightLines()).toHaveLength(1);
    expect((await fd.get('/business-days?from=2026-11-01&to=2026-11-04')).status).toBe(200);
  });
});
