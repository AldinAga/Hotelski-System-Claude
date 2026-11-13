import { startFrontDesk, type FrontDesk } from './front-desk';

const JMBG = '0101990710008';
const MASKED_JMBG = '•••••••••0008';

describe('folio documents (e2e)', () => {
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
  const issue = (stayId: string, kind: 'receipt' | 'proforma', key: string, cookie?: string) =>
    fd.post(`/stays/${stayId}/folio/documents`, { kind, key }, cookie);
  const pay = (stayId: string, amountMinor: number, key: string) =>
    fd.post(`/stays/${stayId}/folio/payments`, { method: 'cash', amountMinor, key });
  const counters = () =>
    fd.sql<{ kind: string; year: number; last: number }>(`SELECT kind, year, last FROM document_counter ORDER BY kind, year`);

  it('a receipt snapshots lines, payments and VAT included in the price', async () => {
    await fd.put('/legal-profile', {
      kind: 'legal_entity', legalName: 'Demo d.o.o.', taxId: '100002887', registryId: '07036540',
      vatPayer: true, address: 'Glavna 1', postalCode: '11000', city: 'Beograd',
    });
    await fd.put('/settings/business', { accommodationVatBp: 1000, vatRatesBp: [2000] });
    const s = await inHouse(0, '2026-11-02', '2026-11-03');
    await fd.post(`/stays/${s.stayId}/folio/charges`, { kind: 'service', description: 'Mini bar', amountMinor: 120_000, vatRateBp: 2000, key: 'charge-doc-01' });
    await fd.post('/business-day/close', { day: '2026-11-02' });
    await fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'card', amountMinor: 1_120_000, key: 'pay-doc-0001' });
    const res = await fd.post(`/stays/${s.stayId}/folio/documents`, { kind: 'receipt', key: 'doc-receipt-1' });
    expect(res.status).toBe(201);
    expect(res.body.number).toBe('N-2026-000001');
    expect(res.body.content).toMatchObject({
      notice: 'Ovo nije fiskalni račun.',
      totalMinor: 1_120_000,
      paidMinor: 1_120_000,
      dueMinor: 0,
      vat: [
        { rateBp: 1000, baseMinor: 909_091, vatMinor: 90_909 },   // 1.000.000 × 10/110 = 90.909,09
        { rateBp: 2000, baseMinor: 100_000, vatMinor: 20_000 },   // 120.000 × 20/120
      ],
    });
    // The rest of the snapshot: issuer, guest, stay, lines and payments as they were.
    expect(res.body.content).toMatchObject({
      kind: 'receipt',
      number: 'N-2026-000001',
      businessDate: '2026-11-03',
      issuedAt: '2026-11-02T08:00:00.000Z', // CLOCK
      seller: {
        legalName: 'Demo d.o.o.', taxId: '100002887', registryId: '07036540', address: 'Glavna 1',
        postalCode: '11000', city: 'Beograd', bankAccount: null, vatPayer: true,
      },
      guest: { name: 'Petar Petrović', email: 'petar@example.com' },
      reservation: { arrival: '2026-11-02', departure: '2026-11-03', unit: 'DBL-1' },
      lines: [
        { description: 'Mini bar', night: null, amountMinor: 120_000, vatRateBp: 2000, expected: false },
        { description: 'Smeštaj 2.11.2026', night: '2026-11-02', amountMinor: 1_000_000, vatRateBp: 1000, expected: false },
      ],
      payments: [{ method: 'card', amountMinor: 1_120_000, businessDate: '2026-11-03' }],
    });
    expect(res.body.content.reservation.number).toMatch(/\S/);
    expect(res.body).toMatchObject({ kind: 'receipt', issuedAt: '2026-11-02T08:00:00.000Z' });
  });

  it('a pro-forma before arrival lists the expected nights and the amount due', async () => {
    const b = await fd.bookStay({ typeId, planId }, '2026-11-05', '2026-11-07');
    await fd.post(`/stays/${b.stayId}/folio/payments`, { method: 'transfer', amountMinor: 500_000, key: 'pay-advance-01' });
    const res = await fd.post(`/stays/${b.stayId}/folio/documents`, { kind: 'proforma', key: 'doc-proforma-1' });
    expect(res.body.number).toBe('P-2026-000001');
    expect(res.body.content).toMatchObject({ totalMinor: 2_000_000, paidMinor: 500_000, dueMinor: 1_500_000 });
    expect(res.body.content.lines.every((l: { expected: boolean }) => l.expected)).toBe(true);
    expect(res.body.content.lines).toEqual([
      { description: 'Smeštaj 5.11.2026', night: '2026-11-05', amountMinor: 1_000_000, vatRateBp: null, expected: true },
      { description: 'Smeštaj 6.11.2026', night: '2026-11-06', amountMinor: 1_000_000, vatRateBp: null, expected: true },
    ]);
    // Without a legal profile row (preflight F30): the seller is empty, not a VAT payer, and there is no VAT recap.
    expect(res.body.content.seller).toEqual({
      legalName: null, taxId: null, registryId: null, address: null, postalCode: null, city: null, bankAccount: null, vatPayer: false,
    });
    expect(res.body.content.vat).toBeNull();
    expect(res.body.content.reservation.unit).toBeNull();
  });

  it('a VAT payer without a rate on a line gets no VAT recap', async () => {
    await fd.put('/legal-profile', {
      kind: 'legal_entity', legalName: 'Demo d.o.o.', taxId: '100002887', registryId: '07036540',
      vatPayer: true, address: 'Glavna 1', city: 'Beograd',
    });
    await fd.put('/settings/business', { accommodationVatBp: 1000 });
    const s = await inHouse(0, '2026-11-02', '2026-11-04');
    await fd.post(`/stays/${s.stayId}/folio/charges`, { kind: 'service', description: 'Parking', amountMinor: 50_000, key: 'charge-norate1' });
    const res = await issue(s.stayId, 'proforma', 'doc-norate-01');
    expect(res.status).toBe(201);
    expect(res.body.content.lines.map((l: { vatRateBp: number | null }) => l.vatRateBp)).toEqual([null, 1000, 1000]);
    expect(res.body.content.vat).toBeNull();
  });

  it('numbering is per kind and year, without gaps when an issue fails', async () => {
    // Another year's counter does not move this year's numbers.
    await fd.sql(`INSERT INTO document_counter (property_id, kind, year, last) SELECT id, 'receipt', 2025, 41 FROM property`);
    const empty = await fd.bookStay({ typeId, planId }, '2026-11-05', '2026-11-06');
    const failed = await issue(empty.stayId, 'receipt', 'doc-empty-001');
    expect(failed.status).toBe(409);
    expect(failed.body.code).toBe('document_empty');
    // The failed issue left neither a folio nor a document behind.
    expect(await fd.sql('SELECT 1 FROM folio')).toHaveLength(0);
    expect(await fd.sql('SELECT 1 FROM folio_document')).toHaveLength(0);

    const s = await inHouse(0, '2026-11-02', '2026-11-03');
    await pay(s.stayId, 10_000, 'pay-number-01');
    expect((await issue(s.stayId, 'receipt', 'doc-number-01')).body.number).toBe('N-2026-000001');
    expect((await issue(s.stayId, 'proforma', 'doc-number-02')).body.number).toBe('P-2026-000001');
    expect((await issue(s.stayId, 'receipt', 'doc-number-03')).body.number).toBe('N-2026-000002');
    expect(await counters()).toEqual([
      { kind: 'proforma', year: 2026, last: 1 },
      { kind: 'receipt', year: 2025, last: 41 },
      { kind: 'receipt', year: 2026, last: 2 },
    ]);
  });

  it('the snapshot does not change after a line is reversed; the database refuses to change it', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-04');
    const line = (await fd.post(`/stays/${s.stayId}/folio/charges`, { kind: 'service', description: 'Mini bar', amountMinor: 40_000, key: 'charge-snap-01' })).body;
    const first = (await issue(s.stayId, 'receipt', 'doc-snap-0001')).body;
    expect(first.content.totalMinor).toBe(40_000);
    expect((await fd.post(`/folio-lines/${line.id}/reverse`, { reason: 'Greška', key: 'reverse-snap1' }, fd.manager)).status).toBe(201);

    const again = await fd.get(`/folio-documents/${first.id}`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first);
    // A new document sees the correction.
    const second = (await issue(s.stayId, 'receipt', 'doc-snap-0002')).body;
    expect(second.content).toMatchObject({ totalMinor: 0, dueMinor: 0 });
    expect(second.content.lines.map((l: { amountMinor: number }) => l.amountMinor)).toEqual([40_000, -40_000]);

    await expect(fd.sql(`UPDATE folio_document SET content = '{}'::jsonb WHERE id = $1`, [first.id])).rejects.toThrow(/append_only/);
    await expect(fd.sql(`DELETE FROM folio_document WHERE id = $1`, [first.id])).rejects.toThrow(/append_only/);
    expect((await fd.get(`/folio-documents/${first.id}`)).body).toEqual(first);
  });

  it('the same key twice: one document, the first answer again with 200, and no number used', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-03');
    await pay(s.stayId, 10_000, 'pay-same-0001');
    const first = await issue(s.stayId, 'receipt', 'doc-same-0001');
    expect(first.status).toBe(201);
    const second = await issue(s.stayId, 'receipt', 'doc-same-0001');
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await fd.sql('SELECT 1 FROM folio_document')).toHaveLength(1);
    // Another body under that key, or a key of a payment: 409, nothing written.
    for (const res of [await issue(s.stayId, 'proforma', 'doc-same-0001'), await issue(s.stayId, 'receipt', 'pay-same-0001')]) {
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('idempotency_key_reused');
    }
    // A document key cannot be replayed as a payment either.
    const asPayment = await pay(s.stayId, 10_000, 'doc-same-0001');
    expect(asPayment.status).toBe(409);
    expect(asPayment.body.code).toBe('idempotency_key_reused');
    // The replays took no number (preflight F5).
    expect((await issue(s.stayId, 'receipt', 'doc-same-0002')).body.number).toBe('N-2026-000002');
    expect(await counters()).toEqual([{ kind: 'receipt', year: 2026, last: 2 }]);
  });

  it('the same key twice in parallel: one document and one number', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-03');
    await pay(s.stayId, 10_000, 'pay-race-0001');
    const results = await fd.raceUnderHeldDay(2, () => [
      issue(s.stayId, 'receipt', 'doc-race-0001'),
      issue(s.stayId, 'receipt', 'doc-race-0001'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(results[0].body).toEqual(results[1].body);
    expect(await fd.sql('SELECT 1 FROM folio_document')).toHaveLength(1);
    expect(await counters()).toEqual([{ kind: 'receipt', year: 2026, last: 1 }]);
  });

  it('two different documents in parallel get consecutive numbers', async () => {
    const a = await inHouse(0, '2026-11-02', '2026-11-03');
    const b = await inHouse(1, '2026-11-02', '2026-11-03');
    await pay(a.stayId, 10_000, 'pay-par-00001');
    await pay(b.stayId, 10_000, 'pay-par-00002');
    const results = await fd.raceUnderHeldDay(2, () => [issue(a.stayId, 'receipt', 'doc-par-00001'), issue(b.stayId, 'receipt', 'doc-par-00002')]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results.map((r) => r.body.number).sort()).toEqual(['N-2026-000001', 'N-2026-000002']);
  });

  it('one key on two stays at once (a receipt and a pro forma): one document, the other is 409 idempotency_key_reused', async () => {
    const a = await inHouse(0, '2026-11-02', '2026-11-03');
    const b = await inHouse(1, '2026-11-02', '2026-11-03');
    await pay(a.stayId, 10_000, 'pay-cross-0001');
    await pay(b.stayId, 10_000, 'pay-cross-0002');
    // Different kinds take different counter rows, so only the unique index can stop the second.
    const results = await fd.raceUnderHeldDay(2, () => [issue(a.stayId, 'receipt', 'doc-cross-0001'), issue(b.stayId, 'proforma', 'doc-cross-0001')]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('idempotency_key_reused');
    expect(await fd.sql('SELECT 1 FROM folio_document')).toHaveLength(1);
  });

  it('a pro forma of a cancelled stay lists no expected nights', async () => {
    const b = await fd.bookStay({ typeId, planId }, '2026-11-05', '2026-11-07');
    await pay(b.stayId, 10_000, 'pay-cancel-001');
    expect((await fd.post(`/reservations/${b.reservationId}/cancel`, { version: b.version })).status).toBe(200);
    const res = await issue(b.stayId, 'proforma', 'doc-cancel-001');
    expect(res.status).toBe(201);
    expect(res.body.content).toMatchObject({ lines: [], totalMinor: 0, paidMinor: 10_000, dueMinor: -10_000 });
  });

  it('in safe mode documents are issued and read', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-03');
    await pay(s.stayId, 10_000, 'pay-safe-0001');
    fd.shiftLicence(400 * 86_400_000);
    const res = await issue(s.stayId, 'receipt', 'doc-safe-0001');
    expect(res.status).toBe(201);
    expect((await fd.get(`/stays/${s.stayId}/folio/documents`)).status).toBe(200);
    expect((await fd.get(`/folio-documents/${res.body.id}`)).status).toBe(200);
  });

  it("seller.registryId of a natural person is masked, and the full JMBG is stored nowhere in the document", async () => {
    await fd.put('/legal-profile', { kind: 'natural_person', legalName: 'Marko Marković', registryId: JMBG, address: 'Selo 1', city: 'Zlatibor' });
    await fd.put('/settings/business', { accommodationVatBp: 1000 });
    const b = await fd.bookStay({ typeId, planId }, '2026-11-05', '2026-11-06');
    const res = await issue(b.stayId, 'proforma', 'doc-natural-01');
    expect(res.status).toBe(201);
    expect(res.body.content.seller).toMatchObject({ legalName: 'Marko Marković', registryId: MASKED_JMBG, taxId: null, vatPayer: false });
    // Every line has a rate, but the seller is not a VAT payer: no VAT recap.
    expect(res.body.content.lines.map((l: { vatRateBp: number | null }) => l.vatRateBp)).toEqual([1000]);
    expect(res.body.content.vat).toBeNull();
    expect(await fd.sql(`SELECT 1 FROM audit_log WHERE action = 'folio.document' AND after::text LIKE $1`, [`%${JMBG}%`])).toHaveLength(0);
    expect(await fd.sql(`SELECT 1 FROM folio_document WHERE content::text LIKE $1`, [`%${JMBG}%`])).toHaveLength(0);
  });

  it('the list shows the documents of a stay oldest first; GET never writes', async () => {
    const fresh = await fd.bookStay({ typeId, planId }, '2026-11-05', '2026-11-06');
    const none = await fd.get(`/stays/${fresh.stayId}/folio/documents`);
    expect(none.status).toBe(200);
    expect(none.body).toEqual([]);
    expect(await fd.sql('SELECT 1 FROM folio')).toHaveLength(0);
    expect(await fd.sql('SELECT 1 FROM business_day')).toHaveLength(0);

    const s = await inHouse(0, '2026-11-02', '2026-11-03');
    await pay(s.stayId, 10_000, 'pay-list-0001');
    const p = (await issue(s.stayId, 'proforma', 'doc-list-0001')).body;
    fd.setNow(new Date('2026-11-02T09:00:00Z'));
    const r = (await issue(s.stayId, 'receipt', 'doc-list-0002')).body;
    const list = await fd.get(`/stays/${s.stayId}/folio/documents`);
    expect(list.body).toEqual([
      { id: p.id, kind: 'proforma', number: 'P-2026-000001', issuedAt: '2026-11-02T08:00:00.000Z' },
      { id: r.id, kind: 'receipt', number: 'N-2026-000001', issuedAt: '2026-11-02T09:00:00.000Z' },
    ]);
    // Another stay's documents are not listed.
    expect((await fd.get(`/stays/${fresh.stayId}/folio/documents`)).body).toEqual([]);
  });

  it('the list is ordered by issue time, not by the order the rows were written', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-03');
    await pay(s.stayId, 10_000, 'pay-order-001');
    fd.setNow(new Date('2026-11-02T09:00:00Z'));
    const later = (await issue(s.stayId, 'receipt', 'doc-order-001')).body;
    // The clock moves back (a correction): this document is written second but issued earlier.
    fd.setNow(new Date('2026-11-02T08:30:00Z'));
    const earlier = (await issue(s.stayId, 'proforma', 'doc-order-002')).body;
    const list = await fd.get(`/stays/${s.stayId}/folio/documents`);
    expect(list.body.map((d: { id: string }) => d.id)).toEqual([earlier.id, later.id]);
  });

  it('a receipt can be issued for a folio that is closed by the check-out', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-03');
    expect((await pay(s.stayId, 1_000_000, 'pay-closed-001')).status).toBe(201);
    expect((await fd.post(`/stays/${s.stayId}/check-out`, { version: s.version })).status).toBe(200);
    expect(await fd.sql(`SELECT status FROM folio`)).toEqual([{ status: 'closed' }]);
    const res = await issue(s.stayId, 'receipt', 'doc-closed-001');
    expect(res.status).toBe(201);
    expect(res.body.content).toMatchObject({ totalMinor: 1_000_000, paidMinor: 1_000_000, dueMinor: 0 });
    expect(await fd.sql(`SELECT status FROM folio`)).toEqual([{ status: 'closed' }]);
  });

  it('the guest of a stay without a stay_guest row is the holder of the reservation', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-03');
    await fd.sql('DELETE FROM stay_guest WHERE stay_id = $1', [s.stayId]); // a stay as phase 1a left it
    const res = await issue(s.stayId, 'proforma', 'doc-holder-001');
    expect(res.status).toBe(201);
    expect(res.body.content.guest).toEqual({ name: 'Petar Petrović', email: 'petar@example.com' });
  });

  it('the number carries the year of the business day, not of the clock', async () => {
    await fd.travel(new Date('2026-12-31T10:00:00Z'));
    const b = await fd.bookStay({ typeId, planId }, '2026-12-31', '2027-01-02');
    // The payment opens the business day 2026-12-31.
    expect((await pay(b.stayId, 10_000, 'pay-year-00001')).status).toBe(201);
    // 06:00 on 2027-01-01 in Belgrade: the calendar and the clock are in the new year, the business day is not closed yet.
    await fd.travel(new Date('2027-01-01T05:00:00Z'));
    const res = await issue(b.stayId, 'receipt', 'doc-year-00001');
    expect(res.status).toBe(201);
    expect(res.body.number).toBe('N-2026-000001');
    expect(res.body.content).toMatchObject({ businessDate: '2026-12-31', number: 'N-2026-000001' });
    expect(res.body.issuedAt).toBe('2027-01-01T05:00:00.000Z');
    expect(await counters()).toEqual([{ kind: 'receipt', year: 2026, last: 1 }]);
  });

  it('unknown stay or document: 404', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    const seen = [];
    for (const [route, res] of [
      ['POST documents', await issue(unknown, 'receipt', 'doc-unknown-01')],
      ['POST documents bad id', await issue('x', 'receipt', 'doc-unknown-02')],
      ['GET list', await fd.get(`/stays/${unknown}/folio/documents`)],
      ['GET list bad id', await fd.get('/stays/x/folio/documents')],
      ['GET document', await fd.get(`/folio-documents/${unknown}`)],
      ['GET document bad id', await fd.get('/folio-documents/x')],
    ] as const) {
      seen.push({ route, status: res.status, code: res.body.code });
    }
    expect(seen).toEqual([
      { route: 'POST documents', status: 404, code: 'stay_not_found' },
      { route: 'POST documents bad id', status: 404, code: 'stay_not_found' },
      { route: 'GET list', status: 404, code: 'stay_not_found' },
      { route: 'GET list bad id', status: 404, code: 'stay_not_found' },
      { route: 'GET document', status: 404, code: 'document_not_found' },
      { route: 'GET document bad id', status: 404, code: 'document_not_found' },
    ]);
  });

  it('kind and key are checked: 422 naming the field, nothing written', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-03');
    await pay(s.stayId, 10_000, 'pay-valid-0001');
    const kind = await fd.post(`/stays/${s.stayId}/folio/documents`, { kind: 'invoice', key: 'doc-valid-0001' });
    expect(kind.status).toBe(422);
    expect(kind.body).toMatchObject({ code: 'validation_failed', details: { field: 'kind' } });
    const key = await fd.post(`/stays/${s.stayId}/folio/documents`, { kind: 'receipt', key: 'short' });
    expect(key.status).toBe(422);
    expect(key.body).toMatchObject({ code: 'validation_failed', details: { field: 'key' } });
    expect(await fd.sql('SELECT 1 FROM folio_document')).toHaveLength(0);
    expect(await counters()).toEqual([]);
  });

  it('an issue is audited with its number and business date', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-03');
    await pay(s.stayId, 10_000, 'pay-audit-0001');
    const doc = (await issue(s.stayId, 'receipt', 'doc-audit-0001', fd.owner)).body;
    const rows = await fd.sql<{ entity: string; entity_id: string; after: Record<string, unknown> }>(
      `SELECT entity, entity_id, after FROM audit_log WHERE action = 'folio.document'`,
    );
    expect(rows).toEqual([
      {
        entity: 'folio_document',
        entity_id: doc.id,
        after: expect.objectContaining({ stayId: s.stayId, kind: 'receipt', number: 'N-2026-000001', businessDate: '2026-11-02', dueMinor: -10_000 }),
      },
    ]);
    const [issued] = await fd.sql<{ issued_by: string }>('SELECT issued_by FROM folio_document');
    expect(issued.issued_by).toBeTruthy();
  });

  it('housekeeping gets forbidden_role on every document route', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-03');
    await pay(s.stayId, 10_000, 'pay-role-00001');
    const doc = (await issue(s.stayId, 'receipt', 'doc-role-00001')).body;
    const seen = [];
    for (const [route, res] of [
      ['POST', await issue(s.stayId, 'receipt', 'doc-role-00002', fd.housekeeping)],
      ['GET list', await fd.get(`/stays/${s.stayId}/folio/documents`, fd.housekeeping)],
      ['GET one', await fd.get(`/folio-documents/${doc.id}`, fd.housekeeping)],
    ] as const) {
      seen.push({ route, status: res.status, code: res.body.code });
    }
    expect(seen).toEqual(['POST', 'GET list', 'GET one'].map((route) => ({ route, status: 403, code: 'forbidden_role' })));
  });

  it('documents are hotel.folio: a licence with hotel.core only refuses them', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-03');
    await pay(s.stayId, 10_000, 'pay-lic-000001');
    const doc = (await issue(s.stayId, 'receipt', 'doc-lic-000001')).body;
    await fd.reset({ modules: ['hotel.core'] });
    // reset() empties the database; the routes are refused before any lookup.
    const seen = [];
    for (const [route, res] of [
      ['POST', await issue(s.stayId, 'receipt', 'doc-lic-000002')],
      ['GET list', await fd.get(`/stays/${s.stayId}/folio/documents`)],
      ['GET one', await fd.get(`/folio-documents/${doc.id}`)],
    ] as const) {
      seen.push({ route, status: res.status, code: res.body.code });
    }
    expect(seen).toEqual(['POST', 'GET list', 'GET one'].map((route) => ({ route, status: 403, code: 'module_not_licensed' })));
  });

  it('the folio view carries the fiscal notice of the legal profile (preflight F8)', async () => {
    const b = await fd.bookStay({ typeId, planId }, '2026-11-05', '2026-11-06');
    expect((await fd.get(`/stays/${b.stayId}/folio`)).body.fiscalNotice).toBeNull();
    const profile = {
      kind: 'legal_entity', legalName: 'Demo d.o.o.', taxId: '100002887', registryId: '07036540',
      address: 'Glavna 1', city: 'Beograd',
    };
    expect((await fd.put('/legal-profile', { ...profile, fiscalComplianceMode: 'required' })).status).toBe(200);
    expect((await fd.get(`/stays/${b.stayId}/folio`)).body.fiscalNotice).toBe('not_available_yet');
    expect((await fd.put('/legal-profile', { ...profile, fiscalComplianceMode: 'disabled' })).status).toBe(200);
    expect((await fd.get(`/stays/${b.stayId}/folio`)).body.fiscalNotice).toBeNull();
  });
});
