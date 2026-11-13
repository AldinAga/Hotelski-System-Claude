import { LegalProfileService } from '../src/legal/legal-profile.service';
import { startFrontDesk, type FrontDesk } from './front-desk';

const PIB = '100002887'; // a real company's PIB (see legal-ids.spec.ts)
const MB = '07036540';
const JMBG = '0101990710008';
const MASKED_JMBG = '•••••••••0008';

describe('legal profile (e2e)', () => {
  let fd: FrontDesk;

  beforeAll(async () => {
    fd = await startFrontDesk();
  });
  beforeEach(async () => {
    await fd.reset();
  });
  afterAll(() => fd.close());

  /** The row setup leaves (phase 1a fields only), for the property the harness made. */
  const seedProfile = async (kind: 'legal_entity' | 'entrepreneur' | 'natural_person', fields: { taxId?: string; registryId?: string } = {}) => {
    await fd.sql(
      `INSERT INTO legal_profile (property_id, kind, tax_id, registry_id, fiscal_compliance_mode)
       SELECT id, $1, $2, $3, CASE $1 WHEN 'natural_person' THEN 'disabled' ELSE 'required' END FROM property`,
      [kind, fields.taxId ?? null, fields.registryId ?? null],
    );
  };
  const stored = async () =>
    (await fd.sql<Record<string, unknown>>(`SELECT * FROM legal_profile`))[0];
  const put = (body: object, cookie?: string) => fd.put('/legal-profile', body, cookie);
  const entityBody = { legalName: 'Hotel Tara d.o.o.', taxId: PIB, registryId: MB, address: 'Ulica 1', city: 'Beograd' };

  it('a legal entity with a wrong PIB gets 422 with field taxId and nothing is written', async () => {
    await seedProfile('legal_entity', { taxId: '100000024', registryId: '12345678' });
    const before = await stored();
    const res = await put({ ...entityBody, taxId: '100002888', legalName: 'Ne sme da se upiše' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'validation_failed', details: { field: 'taxId' } });
    expect(res.body.message).toBe('PIB nije ispravan: kontrolna cifra se ne slaže.');
    expect(await stored()).toEqual(before);
    expect(await fd.sql(`SELECT 1 FROM audit_log WHERE action = 'legal_profile.update'`)).toHaveLength(0);
  });

  it('a legal entity with a matični broj of seven digits gets 422 with field registryId', async () => {
    await seedProfile('legal_entity');
    const res = await put({ ...entityBody, registryId: '7036540' });
    expect(res.status).toBe(422);
    expect(res.body.details).toEqual({ field: 'registryId' });
    expect(res.body.message).toBe('Matični broj nije ispravan: mora imati tačno 8 cifara.');
  });

  it('an entrepreneur without a matični broj gets 422 with field registryId', async () => {
    await seedProfile('entrepreneur');
    const res = await put({ legalName: 'Pr Tara', taxId: PIB, address: 'Ulica 1', city: 'Beograd' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'validation_failed', details: { field: 'registryId' } });
    expect(await stored()).toMatchObject({ tax_id: null, registry_id: null });
  });

  it('a legal entity without a PIB gets 422 with field taxId', async () => {
    await seedProfile('legal_entity');
    const res = await put({ legalName: 'Hotel Tara d.o.o.', registryId: MB });
    expect(res.status).toBe(422);
    expect(res.body.details).toEqual({ field: 'taxId' });
  });

  it('a legal entity is saved and read back with the stamp of the application clock', async () => {
    await seedProfile('legal_entity');
    const res = await put({
      ...entityBody,
      postalCode: '11000',
      activityCode: '5510',
      bankAccount: '160-0000000123456-78',
      email: 'info@tara.example',
      phone: '+381 11 123 456',
      accommodationCategory: 'hotel',
      categorizationNumber: '12-34/2026',
      vatPayer: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'legal_entity',
      legalName: 'Hotel Tara d.o.o.',
      taxId: PIB,
      registryId: MB,
      vatPayer: true,
      address: 'Ulica 1',
      postalCode: '11000',
      city: 'Beograd',
      activityCode: '5510',
      bankAccount: '160-0000000123456-78',
      accommodationCategory: 'hotel',
      fiscalComplianceMode: 'required',
      complete: true,
      missing: [],
    });
    expect(await fd.get('/legal-profile', fd.manager).then((r) => r.body)).toEqual(res.body);
    expect((await stored()).updated_at).toEqual(new Date('2026-11-02T08:00:00Z'));
    const audit = await fd.sql<{ before: { legalName: string | null }; after: { legalName: string } }>(
      `SELECT before, after FROM audit_log WHERE action = 'legal_profile.update'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].before.legalName).toBeNull();
    expect(audit[0].after.legalName).toBe('Hotel Tara d.o.o.');
  });

  it('a field left out of the PUT keeps its stored value; null clears it', async () => {
    await seedProfile('legal_entity');
    await put({ ...entityBody, phone: '+381 11 123 456' });
    const keep = await put({ city: 'Novi Sad' });
    expect(keep.status).toBe(200);
    expect(keep.body).toMatchObject({ city: 'Novi Sad', taxId: PIB, phone: '+381 11 123 456' });
    const cleared = await put({ phone: null });
    expect(cleared.body.phone).toBeNull();
  });

  it('refuses a bank account, an e-mail, a category and a fiscal mode of the wrong shape', async () => {
    await seedProfile('legal_entity');
    for (const [field, value] of [
      ['bankAccount', '160-00000001234567-78'],
      ['email', 'not-an-address'],
      ['accommodationCategory', 'castle'],
      ['fiscalComplianceMode', 'maybe'],
      ['vatPayer', 'yes'],
    ] as const) {
      const res = await put({ ...entityBody, [field]: value });
      expect({ field, status: res.status, details: res.body.details }).toEqual({ field, status: 422, details: { field } });
    }
  });

  it('a natural person: the JMBG is stored, and GET and the audit return it masked', async () => {
    await seedProfile('natural_person');
    const res = await put({ legalName: 'Petar Petrović', registryId: JMBG, address: 'Ulica 2', city: 'Zlatibor' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'natural_person', registryId: MASKED_JMBG, taxId: null, complete: true });
    expect((await stored()).registry_id).toBe(JMBG);
    expect((await fd.get('/legal-profile', fd.owner)).body.registryId).toBe(MASKED_JMBG);
    expect(JSON.stringify(res.body)).not.toContain(JMBG);

    const audit = await fd.sql<{ before: { registryId: string | null }; after: { registryId: string } }>(
      `SELECT before, after FROM audit_log WHERE action = 'legal_profile.update'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].after.registryId).toBe(MASKED_JMBG);
    // The second update shows the masked value on both sides.
    await put({ city: 'Tara' });
    const second = await fd.sql<{ before: { registryId: string }; after: { registryId: string } }>(
      `SELECT before, after FROM audit_log WHERE action = 'legal_profile.update' ORDER BY id DESC LIMIT 1`,
    );
    expect(second[0].before.registryId).toBe(MASKED_JMBG);
    expect(second[0].after.registryId).toBe(MASKED_JMBG);
    expect(await fd.sql(`SELECT 1 FROM audit_log WHERE before::text LIKE $1 OR after::text LIKE $1`, [`%${JMBG}%`])).toHaveLength(0);
  });

  it('a natural person with a wrong JMBG gets 422 with field registryId, and a PIB is optional but checked', async () => {
    await seedProfile('natural_person');
    const wrongDigit = await put({ registryId: '0101990710007' });
    expect(wrongDigit.status).toBe(422);
    expect(wrongDigit.body).toMatchObject({ details: { field: 'registryId' }, message: 'JMBG nije ispravan: kontrolna cifra se ne slaže.' });
    const wrongDate = await put({ registryId: '3102990710005' });
    expect(wrongDate.body.message).toBe('JMBG nije ispravan: datum rođenja ne postoji.');
    const wrongPib = await put({ registryId: JMBG, taxId: '100002888' });
    expect(wrongPib.body.details).toEqual({ field: 'taxId' });
    expect(await stored()).toMatchObject({ registry_id: null, tax_id: null });
    expect((await put({ registryId: JMBG, taxId: PIB })).body.taxId).toBe(PIB);
  });

  it('a PUT carrying the masked JMBG keeps the stored one', async () => {
    await seedProfile('natural_person', { registryId: JMBG });
    const res = await put({ registryId: MASKED_JMBG, city: 'Zlatibor' });
    expect(res.status).toBe(200);
    expect(res.body.registryId).toBe(MASKED_JMBG);
    expect((await stored()).registry_id).toBe(JMBG);
  });

  it('the mask is not a way to fill an empty JMBG: with none stored the field stays empty', async () => {
    await seedProfile('natural_person');
    const res = await put({ registryId: MASKED_JMBG });
    expect(res.status).toBe(200);
    expect(res.body.registryId).toBeNull();
    expect((await stored()).registry_id).toBeNull();
  });

  it('a mask sent for a company is not a matični broj', async () => {
    await seedProfile('legal_entity', { taxId: PIB, registryId: MB });
    const res = await put({ registryId: MASKED_JMBG });
    expect(res.status).toBe(422);
    expect(res.body.details).toEqual({ field: 'registryId' });
  });

  it('fiscalComplianceMode required gives fiscalNotice not_available_yet; the other modes give none', async () => {
    await seedProfile('legal_entity', { taxId: PIB, registryId: MB });
    const required = await fd.get('/legal-profile', fd.manager);
    expect(required.body).toMatchObject({ fiscalComplianceMode: 'required', fiscalNotice: 'not_available_yet' });
    expect((await put({ fiscalComplianceMode: 'invoice_only' })).body).toMatchObject({ fiscalComplianceMode: 'invoice_only', fiscalNotice: null });
    expect((await put({ fiscalComplianceMode: 'disabled' })).body).toMatchObject({ fiscalComplianceMode: 'disabled', fiscalNotice: null });
    expect((await put({ fiscalComplianceMode: 'required' })).body.fiscalNotice).toBe('not_available_yet');
  });

  it('missing names the empty fields an invoice needs, and complete turns true when none is left', async () => {
    await seedProfile('legal_entity');
    const empty = await fd.get('/legal-profile', fd.manager);
    expect(empty.body.missing).toEqual(['legalName', 'address', 'city', 'taxId', 'registryId']);
    expect(empty.body.complete).toBe(false);

    await fd.sql(`DELETE FROM legal_profile`);
    await seedProfile('natural_person');
    const person = await fd.get('/legal-profile', fd.manager);
    expect(person.body.missing).toEqual(['legalName', 'address', 'city']);

    await put({ legalName: 'Petar Petrović', address: 'Ulica 2' });
    expect((await fd.get('/legal-profile', fd.manager)).body).toMatchObject({ missing: ['city'], complete: false });
    expect((await put({ city: 'Zlatibor' })).body).toMatchObject({ missing: [], complete: true });
  });

  it('GET writes nothing', async () => {
    await seedProfile('legal_entity');
    const before = await stored();
    await fd.get('/legal-profile', fd.manager);
    expect(await stored()).toEqual(before);
    expect(await fd.sql(`SELECT 1 FROM audit_log WHERE action = 'legal_profile.update'`)).toHaveLength(0);
  });

  describe('before the profile exists (only the property row, as the test database has it)', () => {
    const rows = () => fd.sql(`SELECT 1 FROM legal_profile`);
    const audits = () => fd.sql(`SELECT 1 FROM audit_log WHERE action = 'legal_profile.update'`);

    it('GET answers kind null, every field null, complete false, and writes nothing', async () => {
      const res = await fd.get('/legal-profile', fd.manager);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        kind: null,
        legalName: null,
        taxId: null,
        registryId: null,
        vatPayer: false,
        address: null,
        postalCode: null,
        city: null,
        activityCode: null,
        bankAccount: null,
        email: null,
        phone: null,
        accommodationCategory: null,
        categorizationNumber: null,
        fiscalComplianceMode: null,
        fiscalNotice: null,
        complete: false,
        missing: ['legalName', 'address', 'city', 'taxId', 'registryId'],
      });
      expect(await rows()).toHaveLength(0);
      expect(await audits()).toHaveLength(0);
    });

    it('LegalProfileService.get() does not throw for a missing row', async () => {
      const view = await fd.app.get(LegalProfileService).get();
      expect(view).toMatchObject({ kind: null, complete: false });
    });

    it('PUT without kind is 422 with field kind and creates nothing', async () => {
      const res = await put(entityBody);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'validation_failed', details: { field: 'kind' } });
      expect(await rows()).toHaveLength(0);
    });

    it('PUT with an unknown kind is 422 with field kind', async () => {
      const res = await put({ ...entityBody, kind: 'corporation' });
      expect(res.status).toBe(422);
      expect(res.body.details).toEqual({ field: 'kind' });
      expect(await rows()).toHaveLength(0);
    });

    it('PUT with kind creates the row: legal entity defaults to required, audit before is null', async () => {
      const res = await put({ ...entityBody, kind: 'legal_entity' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ kind: 'legal_entity', taxId: PIB, fiscalComplianceMode: 'required', fiscalNotice: 'not_available_yet', complete: true });
      expect(await stored()).toMatchObject({ kind: 'legal_entity', tax_id: PIB, registry_id: MB, fiscal_compliance_mode: 'required' });
      const audit = await fd.sql<{ before: unknown; after: { kind: string } }>(
        `SELECT before, after FROM audit_log WHERE action = 'legal_profile.update'`,
      );
      expect(audit).toHaveLength(1);
      expect(audit[0].before).toBeNull();
      expect(audit[0].after.kind).toBe('legal_entity');
      expect((await fd.get('/legal-profile', fd.manager)).body).toEqual(res.body);
    });

    it('PUT creates a natural person with fiscalisation disabled and the JMBG masked', async () => {
      const res = await put({ kind: 'natural_person', registryId: JMBG });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ kind: 'natural_person', registryId: MASKED_JMBG, fiscalComplianceMode: 'disabled', fiscalNotice: null });
    });

    it('a PUT that fails validation does not leave a row behind', async () => {
      const res = await put({ ...entityBody, kind: 'legal_entity', taxId: '100002888' });
      expect(res.status).toBe(422);
      expect(res.body.details).toEqual({ field: 'taxId' });
      expect(await rows()).toHaveLength(0);
      expect(await audits()).toHaveLength(0);
    });
  });

  it('on an existing row PUT may repeat the kind but not change it', async () => {
    await seedProfile('legal_entity', { taxId: PIB, registryId: MB });
    const same = await put({ kind: 'legal_entity', city: 'Niš' });
    expect(same.status).toBe(200);
    expect(same.body.city).toBe('Niš');
    const other = await put({ kind: 'natural_person', city: 'Kraljevo' });
    expect(other.status).toBe(422);
    expect(other.body.details).toEqual({ field: 'kind' });
    expect(await stored()).toMatchObject({ kind: 'legal_entity', city: 'Niš' });
    const bad = await put({ kind: 'corporation' });
    expect(bad.status).toBe(422);
    expect(bad.body.details).toEqual({ field: 'kind' });
  });

  it('PIB and JMBG of the wrong length are refused with their own message', async () => {
    await seedProfile('legal_entity');
    const pib = await put({ ...entityBody, taxId: '10000288' });
    expect(pib.body).toMatchObject({ details: { field: 'taxId' }, message: 'PIB nije ispravan: mora imati tačno 9 cifara.' });
    await fd.sql(`TRUNCATE legal_profile`);
    await seedProfile('natural_person');
    const jmbg = await put({ registryId: '010199071000' });
    expect(jmbg.body).toMatchObject({ details: { field: 'registryId' }, message: 'JMBG nije ispravan: mora imati tačno 13 cifara.' });
  });

  it('the receptionist and housekeeping get 403 forbidden_role on GET and PUT; owner and manager read', async () => {
    await seedProfile('legal_entity', { taxId: PIB, registryId: MB });
    for (const cookie of [fd.receptionist, fd.housekeeping]) {
      const get = await fd.get('/legal-profile', cookie);
      expect({ status: get.status, code: get.body.code }).toEqual({ status: 403, code: 'forbidden_role' });
      const res = await put({ city: 'Niš' }, cookie);
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'forbidden_role' });
    }
    expect((await fd.get('/legal-profile', fd.owner)).status).toBe(200);
    expect((await fd.get('/legal-profile', fd.manager)).status).toBe(200);
    expect((await put({ city: 'Niš' }, fd.owner)).status).toBe(200);
  });

  it('in safe mode GET works and PUT is safe_mode_blocked', async () => {
    await seedProfile('legal_entity', { taxId: PIB, registryId: MB });
    fd.shiftLicence(400 * 86_400_000);
    expect((await fd.get('/legal-profile', fd.manager)).status).toBe(200);
    const res = await put({ city: 'Niš' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('safe_mode_blocked');
    expect((await stored()).city).toBeNull();
  });
});
