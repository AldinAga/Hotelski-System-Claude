import { NOW, startFrontDesk, type FrontDesk } from './front-desk';

describe('check-in and check-out (e2e)', () => {
  let fd: FrontDesk;
  let typeId: string;
  let planId: string;
  let unitIds: string[];

  beforeAll(async () => {
    fd = await startFrontDesk();
  });
  beforeEach(async () => {
    await fd.reset();
    ({ typeId, planId, unitIds } = await fd.pricedType('DBL', 2));
  });
  afterAll(() => fd.close());

  const inHouse = (arrival: string, departure: string, unit = 0) => fd.inHouse({ typeId, planId, unitId: unitIds[unit] }, arrival, departure);
  const ledger = async (day: string) =>
    (await fd.sql<{ sold: number }>(`SELECT sold FROM inventory_day WHERE scope_id = $1 AND day = $2`, [typeId, day]))[0]?.sold;
  const stayStatus = async (stayId: string) => (await fd.sql<{ status: string }>('SELECT status FROM stay WHERE id = $1', [stayId]))[0];
  /** The state after an evening close: `closed` closed (clock unchanged), `open` the open business day. */
  async function businessDays(closed: string, open: string) {
    await fd.sql(`UPDATE business_day SET status = 'closed', closed_at = now(), close_mode = 'manual', report = '{}' WHERE day = $1`, [closed]);
    await fd.sql(`INSERT INTO business_day (property_id, day, status, opened_at) SELECT id, $1::date, 'open', now() FROM property`, [open]);
  }

  it('check-in on the arrival day: in house, holder is the primary guest, a folio exists, version + 1', async () => {
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-02', '2026-11-04');
    await fd.sql('DELETE FROM stay_guest WHERE stay_id = $1', [b.stayId]); // a stay as phase 1a left it
    const res = await fd.post(`/stays/${b.stayId}/check-in`, { version: b.version });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stayId: b.stayId, status: 'in_house', version: b.version + 1 });
    expect(await fd.sql('SELECT is_primary FROM stay_guest WHERE stay_id = $1', [b.stayId])).toEqual([{ is_primary: true }]);
    expect(await fd.sql(`SELECT status FROM folio WHERE stay_id = $1`, [b.stayId])).toEqual([{ status: 'open' }]);
    expect(
      await fd.sql(
        `SELECT checked_in_at, checked_in_by, checked_in_business_date::text AS bd FROM stay WHERE id = $1`,
        [b.stayId],
      ),
    ).toEqual([{ checked_in_at: NOW, checked_in_by: expect.any(String), bd: '2026-11-02' }]);
    const audit = await fd.sql<{ after: Record<string, unknown> }>(`SELECT after FROM audit_log WHERE action = 'stay.check_in'`);
    expect(audit).toEqual([{ after: expect.objectContaining({ status: 'in_house', version: b.version + 1, businessDate: '2026-11-02' }) }]);
  });

  it('check-in on another day than the business date is 409 naming both dates; nothing changes', async () => {
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-03', '2026-11-04');
    const res = await fd.post(`/stays/${b.stayId}/check-in`, { version: b.version });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'check_in_wrong_day',
      details: { arrival: '2026-11-03', businessDate: '2026-11-02' },
    });
    expect(await stayStatus(b.stayId)).toEqual({ status: 'expected' });
  });

  it('check-in without a unit is 422 unit_required; with a stale version 409 version_conflict', async () => {
    const b = await fd.bookStay({ typeId, planId }, '2026-11-02', '2026-11-03');
    expect((await fd.post(`/stays/${b.stayId}/check-in`, { version: b.version })).body.code).toBe('unit_required');
    const c = await fd.bookStay({ typeId, planId, unitId: unitIds[1] }, '2026-11-02', '2026-11-03');
    expect((await fd.post(`/stays/${c.stayId}/check-in`, { version: c.version + 1 })).body.code).toBe('version_conflict');
    expect([await stayStatus(b.stayId), await stayStatus(c.stayId)]).toEqual([{ status: 'expected' }, { status: 'expected' }]);
  });

  it('a second check-in is 409 stay_not_expected with the status', async () => {
    const s = await inHouse('2026-11-02', '2026-11-03');
    const res = await fd.post(`/stays/${s.stayId}/check-in`, { version: s.version });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'stay_not_expected', details: { status: 'in_house' } });
  });

  it('check-in on a reservation that is not confirmed is 409 reservation_not_confirmed', async () => {
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-02', '2026-11-03');
    await fd.sql(`UPDATE reservation SET status = 'requested' WHERE id = $1`, [b.reservationId]);
    const res = await fd.post(`/stays/${b.stayId}/check-in`, { version: b.version });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'reservation_not_confirmed', details: { status: 'requested' } });
    expect(await stayStatus(b.stayId)).toEqual({ status: 'expected' });
  });

  it('check-in on an inactive unit is 409 unit_inactive', async () => {
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-02', '2026-11-03');
    await fd.sql('UPDATE unit SET active = false WHERE id = $1', [unitIds[0]]);
    const res = await fd.post(`/stays/${b.stayId}/check-in`, { version: b.version });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'unit_inactive', details: { unitId: unitIds[0] } });
  });

  it('check-in on a blocked unit: 409 unit_blocked', async () => {
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-02', '2026-11-04');
    // Through SQL (preflight F25): the API refuses a block over a live stay (unit_occupied),
    // so only data from phase 1a can reach this check.
    await fd.sql(
      `INSERT INTO unit_block (property_id, unit_id, period, reason, created_by)
       SELECT property_id, id, daterange('2026-11-03', '2026-11-04'), 'maintenance', $2 FROM unit WHERE id = $1`,
      [unitIds[0], fd.managerId],
    );
    const res = await fd.post(`/stays/${b.stayId}/check-in`, { version: b.version });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'unit_blocked', details: { unitId: unitIds[0] } });
    expect(await stayStatus(b.stayId)).toEqual({ status: 'expected' });
  });

  it('check-out with an open balance is 409 with the amount and leaves everything as it was', async () => {
    const s = await inHouse('2026-11-02', '2026-11-03');
    const res = await fd.post(`/stays/${s.stayId}/check-out`, { version: s.version });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'folio_balance_open', details: { balanceMinor: 1_000_000 } });
    expect(await stayStatus(s.stayId)).toEqual({ status: 'in_house' });
    expect(await fd.sql('SELECT 1 FROM folio_line')).toHaveLength(0);
  });

  it('check-out with a stale version is 409 version_conflict', async () => {
    const s = await inHouse('2026-11-02', '2026-11-03');
    await fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'card', amountMinor: 1_000_000, key: 'pay-stale-0001' });
    const res = await fd.post(`/stays/${s.stayId}/check-out`, { version: s.version - 1 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'version_conflict', details: { version: s.version } });
    expect(await stayStatus(s.stayId)).toEqual({ status: 'in_house' });
  });

  it('leaving on the arrival day posts that night, closes the folio and frees the unit', async () => {
    const s = await inHouse('2026-11-02', '2026-11-03');
    const preview = (await fd.get(`/stays/${s.stayId}/check-out-preview`)).body;
    expect(preview).toEqual({
      businessDate: '2026-11-02',
      keptUntil: '2026-11-03',
      earlyDeparture: false,
      nightsToPost: [{ night: '2026-11-02', priceMinor: 1_000_000 }],
      nightsToRelease: [],
      balanceMinor: 1_000_000,
    });
    expect(await fd.sql('SELECT 1 FROM folio_line')).toHaveLength(0); // the preview posts nothing
    await fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'card', amountMinor: 1_000_000, key: 'pay-checkout-1' });
    const res = await fd.post(`/stays/${s.stayId}/check-out`, { version: s.version });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'checked_out', version: s.version + 1, departure: '2026-11-03' });
    const f = (await fd.get(`/stays/${s.stayId}/folio`)).body;
    expect(f).toMatchObject({ status: 'closed', balanceMinor: 0 });
    expect(f.lines).toEqual([expect.objectContaining({ kind: 'accommodation', night: '2026-11-02', sourceType: 'check_out' })]);
    expect(
      await fd.sql(`SELECT checked_out_at, checked_out_business_date::text AS bd FROM stay WHERE id = $1`, [s.stayId]),
    ).toEqual([{ checked_out_at: NOW, bd: '2026-11-02' }]);
    const again = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-02', '2026-11-03');
    expect(again.stayId).toBeDefined(); // the exclusion constraint no longer holds the unit
  });

  it('an early departure gives back the unused nights and shortens the stay', async () => {
    const s = await inHouse('2026-11-02', '2026-11-05');
    expect([await ledger('2026-11-03'), await ledger('2026-11-04')]).toEqual([1, 1]);
    expect((await fd.get(`/stays/${s.stayId}/check-out-preview`)).body).toMatchObject({
      keptUntil: '2026-11-03',
      earlyDeparture: true,
      nightsToRelease: ['2026-11-03', '2026-11-04'],
    });
    await fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'cash', amountMinor: 1_000_000, key: 'pay-early-001' });
    const res = await fd.post(`/stays/${s.stayId}/check-out`, { version: s.version });
    expect(res.status).toBe(200);
    expect(res.body.departure).toBe('2026-11-03');
    expect([await ledger('2026-11-02'), await ledger('2026-11-03'), await ledger('2026-11-04')]).toEqual([1, 0, 0]);
    expect(await fd.sql(`SELECT day::text AS day FROM stay_night WHERE stay_id = $1`, [s.stayId])).toEqual([
      { day: '2026-11-02' },
    ]);
    expect(await fd.sql(`SELECT departure::text AS departure FROM stay WHERE id = $1`, [s.stayId])).toEqual([
      { departure: '2026-11-03' },
    ]);
    const audit = await fd.sql<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `SELECT before, after FROM audit_log WHERE action = 'stay.check_out'`,
    );
    expect(audit).toEqual([
      {
        before: expect.objectContaining({ departure: '2026-11-05' }),
        after: expect.objectContaining({
          departure: '2026-11-03',
          earlyDeparture: true,
          releasedNights: ['2026-11-03', '2026-11-04'],
          postedNights: ['2026-11-02'],
        }),
      },
    ]);
  });

  it('nights posted by one check-out are listed in night order (Ruling 30)', async () => {
    const s = await inHouse('2026-11-02', '2026-11-08');
    // Five business days later without the night audit (Task 6): 11-02 closed, 11-07 open.
    // The clock stays at NOW (moving it would end the sessions); postings take the open day.
    await businessDays('2026-11-02', '2026-11-07');
    await fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'cash', amountMinor: 5_000_000, key: 'pay-five-nights' });
    const res = await fd.post(`/stays/${s.stayId}/check-out`, { version: s.version });
    expect(res.status).toBe(200);
    expect(res.body.departure).toBe('2026-11-07');
    const f = (await fd.get(`/stays/${s.stayId}/folio`)).body;
    expect(f.lines.map((l: { night: string; businessDate: string }) => [l.night, l.businessDate])).toEqual([
      ['2026-11-02', '2026-11-07'],
      ['2026-11-03', '2026-11-07'],
      ['2026-11-04', '2026-11-07'],
      ['2026-11-05', '2026-11-07'],
      ['2026-11-06', '2026-11-07'],
    ]);
    expect(f).toMatchObject({ status: 'closed', balanceMinor: 0 });
  });

  it('a payment racing a check-out either lands first or is refused with folio_closed', async () => {
    const s = await inHouse('2026-11-02', '2026-11-03');
    await fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'cash', amountMinor: 1_000_000, key: 'pay-race-0001' });
    const [out, pay] = await fd.raceUnderHeldDay(2, () => [
      fd.post(`/stays/${s.stayId}/check-out`, { version: s.version }),
      fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'cash', amountMinor: 5_000, key: 'pay-race-0002' }),
    ]);
    if (out.status === 200) {
      expect(pay.status).toBe(409);
      expect(pay.body.code).toBe('folio_closed');
    } else {
      expect(out.body).toMatchObject({ code: 'folio_balance_open', details: { balanceMinor: -5_000 } });
      expect(pay.status).toBe(201);
    }
    const f = (await fd.get(`/stays/${s.stayId}/folio`)).body;
    expect(f.status).toBe(out.status === 200 ? 'closed' : 'open');
    // The oracle is what this test paid: 1_000_000 + 5_000, and the failed check-out rolled
    // its night back (preflight F1). A closed folio never carries a balance.
    expect(f.balanceMinor).toBe(out.status === 200 ? 0 : -1_005_000);
  });

  it('check-out of a stay that is not in the house: 409 stay_not_in_house, preview too', async () => {
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-02', '2026-11-03');
    const res = await fd.post(`/stays/${b.stayId}/check-out`, { version: b.version });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'stay_not_in_house', details: { status: 'expected' } });
    const preview = await fd.get(`/stays/${b.stayId}/check-out-preview`);
    expect(preview.status).toBe(409);
    expect(preview.body).toMatchObject({ code: 'stay_not_in_house', details: { status: 'expected' } });
  });

  it('after the close of 2026-11-02 (clock still 2026-11-02) arrival 2026-11-02 is 422 arrival_before_business_date, quote too; 2026-11-03 books', async () => {
    // The close itself is Task 6 (preflight F3): its result is written here.
    await fd.sql(`INSERT INTO business_day (property_id, day, status, opened_at) SELECT id, '2026-11-02', 'open', now() FROM property`);
    await businessDays('2026-11-02', '2026-11-03');
    const body = (arrival: string, departure: string) => ({
      source: 'front_desk',
      holder: { firstName: 'Petar', lastName: 'Petrović' },
      stays: [{ unitTypeId: typeId, arrival, departure, adults: 2, ratePlanId: planId }],
    });
    for (const path of ['/reservations', '/reservations/quote']) {
      const res = await fd.post(path, body('2026-11-02', '2026-11-04'));
      expect([path, res.status]).toEqual([path, 422]);
      expect(res.body).toMatchObject({
        code: 'arrival_before_business_date',
        details: { arrival: '2026-11-02', businessDate: '2026-11-03', stay: 0 },
      });
    }
    expect((await fd.post('/reservations', body('2026-11-03', '2026-11-04'))).status).toBe(201);
    expect((await fd.post('/reservations/quote', body('2026-11-03', '2026-11-04'))).status).toBe(200);
  });

  it('housekeeping: 403 on check-in, the check-out preview and check-out', async () => {
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-02', '2026-11-03');
    const answers = [
      await fd.post(`/stays/${b.stayId}/check-in`, { version: b.version }, fd.housekeeping),
      await fd.get(`/stays/${b.stayId}/check-out-preview`, fd.housekeeping),
      await fd.post(`/stays/${b.stayId}/check-out`, { version: b.version }, fd.housekeeping),
    ];
    expect(answers.map((r) => [r.status, r.body.code])).toEqual([
      [403, 'forbidden_role'],
      [403, 'forbidden_role'],
      [403, 'forbidden_role'],
    ]);
    expect(await stayStatus(b.stayId)).toEqual({ status: 'expected' });
  });

  it('in safe mode check-out works and check-in is safe_mode_blocked', async () => {
    const s = await inHouse('2026-11-02', '2026-11-03');
    const other = await fd.bookStay({ typeId, planId, unitId: unitIds[1] }, '2026-11-02', '2026-11-03');
    await fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'cash', amountMinor: 1_000_000, key: 'pay-safe-0001' });
    fd.shiftLicence(400 * 86_400_000);
    expect((await fd.post(`/stays/${other.stayId}/check-in`, { version: other.version })).body.code).toBe('safe_mode_blocked');
    expect((await fd.get(`/stays/${s.stayId}/check-out-preview`)).status).toBe(200);
    expect((await fd.post(`/stays/${s.stayId}/check-out`, { version: s.version })).status).toBe(200);
  });
});
