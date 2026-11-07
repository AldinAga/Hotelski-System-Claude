import { DB, type Db } from '../src/db/tokens';
import { GuestsService } from '../src/guests/guests.service';
import { DAY_MS, startFrontDesk, type FrontDesk } from './front-desk';

describe('guests (e2e)', () => {
  let fd: FrontDesk;

  beforeAll(async () => {
    fd = await startFrontDesk();
  });
  beforeEach(async () => {
    await fd.reset();
  });
  afterAll(async () => {
    await fd.close();
  });

  async function audit(action: string) {
    return fd.sql<{ entity: string; entity_id: string; before: unknown; after: Record<string, unknown>; actor_user_id: string }>(
      `SELECT entity, entity_id, before, after, actor_user_id FROM audit_log WHERE action = $1 ORDER BY id`,
      [action],
    );
  }

  async function stayGuests(stayId: string) {
    return fd.sql<{ guest_id: string; is_primary: boolean }>(
      `SELECT guest_id, is_primary FROM stay_guest WHERE stay_id = $1 ORDER BY is_primary DESC, added_at, guest_id`,
      [stayId],
    );
  }

  async function count(table: 'guest' | 'stay_guest'): Promise<number> {
    return (await fd.sql<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0].n;
  }

  async function newGuest(firstName: string, lastName: string, extra: object = {}): Promise<string> {
    const res = await fd.post('/guests', { firstName, lastName, ...extra });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function bookOne(extra: { adults?: number; children?: number } = {}) {
    const t = await fd.pricedType('DBL', 2);
    return fd.bookStay(t, '2026-11-10', '2026-11-12', extra);
  }

  it('book writes the holder as the primary guest of every stay; GET /reservations/:id returns the stay guests', async () => {
    const t = await fd.pricedType('DBL', 2);
    const res = await fd.post('/reservations', {
      source: 'front_desk',
      holder: { firstName: 'Petar', lastName: 'Petrović', email: 'petar@example.com', phone: '+381 64 111' },
      stays: [
        { unitTypeId: t.typeId, arrival: '2026-11-10', departure: '2026-11-12', adults: 2, ratePlanId: t.planId },
        { unitTypeId: t.typeId, arrival: '2026-11-11', departure: '2026-11-13', adults: 1, ratePlanId: t.planId },
      ],
    });
    expect(res.status).toBe(201);
    const view = await fd.get(`/reservations/${res.body.reservationId}`);
    expect(view.status).toBe(200);
    const holder = view.body.holder;
    const expected = [
      {
        id: holder.id,
        firstName: 'Petar',
        lastName: 'Petrović',
        email: 'petar@example.com',
        phone: '+381 64 111',
        language: 'sr',
        note: null,
        isPrimary: true,
      },
    ];
    expect(view.body.stays).toHaveLength(2);
    for (const s of view.body.stays) expect(s.guests).toEqual(expected);
    const rows = await fd.sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM stay_guest sg JOIN stay s ON s.id = sg.stay_id
        WHERE s.reservation_id = $1 AND sg.is_primary AND sg.guest_id = $2`,
      [res.body.reservationId, holder.id],
    );
    expect(rows[0].n).toBe(2);
  });

  it('POST /guests and PATCH /guests/:id: validated, audited, note kept', async () => {
    const bad = await fd.post('/guests', { firstName: 'Ana', lastName: '' });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: 'validation_failed', details: { field: 'lastName' } });
    expect((await fd.post('/guests', { firstName: 'Ana', lastName: 'Anić', email: 'nije-adresa' })).body.details).toEqual({
      field: 'email',
    });
    expect((await fd.post('/guests', { firstName: 'Ana', lastName: 'Anić', note: 'x'.repeat(2001) })).body.details).toEqual({
      field: 'note',
    });

    const created = await fd.post('/guests', { firstName: ' Ana ', lastName: 'Anić', email: 'ana@example.com', note: 'Alergija na orahe' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.any(String),
      firstName: 'Ana',
      lastName: 'Anić',
      email: 'ana@example.com',
      phone: null,
      language: 'sr',
      note: 'Alergija na orahe',
    });
    const id = created.body.id as string;
    expect(await audit('guest.create')).toEqual([
      expect.objectContaining({ entity: 'guest', entity_id: id, after: expect.objectContaining({ firstName: 'Ana', lastName: 'Anić' }) }),
    ]);

    const patched = await fd.patch(`/guests/${id}`, { phone: '+381 11 222', note: null }, fd.receptionist);
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ id, firstName: 'Ana', phone: '+381 11 222', note: null, email: 'ana@example.com' });
    const updates = await audit('guest.update');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ entity: 'guest', entity_id: id });

    expect((await fd.patch('/guests/00000000-0000-4000-8000-000000000000', { note: 'x' })).status).toBe(404);
    expect((await fd.patch(`/guests/${id}`, { language: 'srb' })).body.details).toEqual({ field: 'language' });
    const blankName = await fd.patch(`/guests/${id}`, { lastName: '  ' });
    expect(blankName.status).toBe(422);
    expect(blankName.body.details).toEqual({ field: 'lastName' });
  });

  it('adds a new guest and an existing guest (guestId) to a stay; audit stay.guest_add; version unchanged', async () => {
    const booked = await bookOne({ adults: 2, children: 1 });
    const existing = await newGuest('Ana', 'Anić');

    // While the stay still has room, so the guest lookup and the body check answer, not the guest limit.
    const missing = await fd.post(`/stays/${booked.stayId}/guests`, { guestId: '00000000-0000-4000-8000-000000000000' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('guest_not_found');
    const neither = await fd.post(`/stays/${booked.stayId}/guests`, {});
    expect(neither.status).toBe(422);
    expect(neither.body).toMatchObject({ code: 'validation_failed', details: { field: 'guestId' } });

    const addNew = await fd.post(`/stays/${booked.stayId}/guests`, { guest: { firstName: 'Mila', lastName: 'Milić' } });
    expect(addNew.status).toBe(201);
    const addExisting = await fd.post(`/stays/${booked.stayId}/guests`, { guestId: existing });
    expect(addExisting.status).toBe(201);
    expect(addExisting.body.map((g: { firstName: string; isPrimary: boolean }) => [g.firstName, g.isPrimary])).toEqual([
      ['Petar', true],
      ['Mila', false],
      ['Ana', false],
    ]);
    expect(await stayGuests(booked.stayId)).toHaveLength(3);

    const adds = await audit('stay.guest_add');
    expect(adds).toHaveLength(2);
    expect(adds[1]).toMatchObject({ entity: 'stay', entity_id: booked.stayId, after: { guestId: existing } });

    const view = await fd.get(`/reservations/${booked.reservationId}`);
    expect(view.body.version).toBe(booked.version);
    expect(view.body.stays[0].guests).toHaveLength(3);

    expect((await fd.post('/stays/00000000-0000-4000-8000-000000000000/guests', { guestId: existing })).body.code).toBe(
      'stay_not_found',
    );
  });

  it('a third guest on a stay for 2 adults: 422 too_many_guests with limit 2, nothing written', async () => {
    const booked = await bookOne({ adults: 2 });
    // The second guest fits exactly (holder + 1 = adults + children).
    expect((await fd.post(`/stays/${booked.stayId}/guests`, { guest: { firstName: 'Mila', lastName: 'Milić' } })).status).toBe(201);
    const guestsBefore = await count('guest');

    const third = await fd.post(`/stays/${booked.stayId}/guests`, { guest: { firstName: 'Treći', lastName: 'Gost' } });
    expect(third.status).toBe(422);
    expect(third.body).toMatchObject({ code: 'too_many_guests', details: { limit: 2 } });
    expect(await stayGuests(booked.stayId)).toHaveLength(2);
    expect(await count('guest')).toBe(guestsBefore);
    expect(await audit('stay.guest_add')).toHaveLength(1);
  });

  it('the same guest twice: 409 guest_already_on_stay', async () => {
    const booked = await bookOne({ adults: 2, children: 2 });
    const ana = await newGuest('Ana', 'Anić');
    expect((await fd.post(`/stays/${booked.stayId}/guests`, { guestId: ana })).status).toBe(201);
    const again = await fd.post(`/stays/${booked.stayId}/guests`, { guestId: ana });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('guest_already_on_stay');
    expect(await stayGuests(booked.stayId)).toHaveLength(2);
  });

  it('removing the primary guest: 409 primary_guest_required; after setPrimary on another guest the old one can go', async () => {
    const booked = await bookOne({ adults: 2 });
    const [holder] = await stayGuests(booked.stayId);
    const ana = await newGuest('Ana', 'Anić');
    expect((await fd.post(`/stays/${booked.stayId}/guests`, { guestId: ana })).status).toBe(201);

    const refused = await fd.del(`/stays/${booked.stayId}/guests/${holder.guest_id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('primary_guest_required');
    expect(await stayGuests(booked.stayId)).toHaveLength(2);

    const primary = await fd.post(`/stays/${booked.stayId}/guests/${ana}/primary`);
    expect(primary.status).toBe(200);
    expect(await stayGuests(booked.stayId)).toEqual([
      { guest_id: ana, is_primary: true },
      { guest_id: holder.guest_id, is_primary: false },
    ]);
    expect(await audit('stay.guest_primary')).toEqual([
      expect.objectContaining({ entity_id: booked.stayId, before: { guestId: holder.guest_id }, after: { guestId: ana } }),
    ]);

    const removed = await fd.del(`/stays/${booked.stayId}/guests/${holder.guest_id}`);
    expect(removed.status).toBe(200);
    expect(await stayGuests(booked.stayId)).toEqual([{ guest_id: ana, is_primary: true }]);
    expect(await audit('stay.guest_remove')).toEqual([expect.objectContaining({ entity_id: booked.stayId, before: { guestId: holder.guest_id } })]);
    // The guest record itself stays (other stays and documents may name it).
    expect((await fd.sql(`SELECT 1 FROM guest WHERE id = $1`, [holder.guest_id])).length).toBe(1);

    const notOn = await fd.del(`/stays/${booked.stayId}/guests/${holder.guest_id}`);
    expect(notOn.status).toBe(404);
    expect(notOn.body.code).toBe('guest_not_on_stay');
    expect((await fd.post(`/stays/${booked.stayId}/guests/${holder.guest_id}/primary`)).body.code).toBe('guest_not_on_stay');

    const view = await fd.get(`/reservations/${booked.reservationId}`);
    expect(view.body.version).toBe(booked.version);
  });

  it('a guest on a cancelled stay: 409 stay_not_editable', async () => {
    const booked = await bookOne({ adults: 2, children: 1 });
    const ana = await newGuest('Ana', 'Anić');
    const cancelled = await fd.post(`/reservations/${booked.reservationId}/cancel`, { version: booked.version });
    expect(cancelled.status).toBe(200);
    const [holder] = await stayGuests(booked.stayId);

    const add = await fd.post(`/stays/${booked.stayId}/guests`, { guestId: ana });
    expect(add.status).toBe(409);
    expect(add.body).toMatchObject({ code: 'stay_not_editable', details: { status: 'cancelled' } });
    expect((await fd.del(`/stays/${booked.stayId}/guests/${holder.guest_id}`)).body.code).toBe('stay_not_editable');
    expect((await fd.post(`/stays/${booked.stayId}/guests/${holder.guest_id}/primary`)).body.code).toBe('stay_not_editable');
    expect(await stayGuests(booked.stayId)).toHaveLength(1);
  });

  it('search by part of the last name and by e-mail; % in the query is matched literally', async () => {
    await newGuest('Marko', 'Popović', { email: 'marko@primer.rs' });
    await newGuest('Jelena', 'Popadić', { phone: '+381 63 777' });
    await newGuest('Ana', '100% Anić');
    await newGuest('Ivan', 'Ivić', { email: 'ivan@drugi.rs' });

    const names = (res: { body: Array<{ lastName: string }> }) => res.body.map((g) => g.lastName).sort();
    const byName = await fd.get('/guests?q=opov');
    expect(byName.status).toBe(200);
    expect(names(byName)).toEqual(['Popović']);
    expect(names(await fd.get('/guests?q=pop'))).toEqual(['Popadić', 'Popović']);
    expect(names(await fd.get('/guests?q=primer.rs'))).toEqual(['Popović']);
    expect(names(await fd.get('/guests?q=63%20777'))).toEqual(['Popadić']);
    // Unescaped, % would match every guest.
    expect(names(await fd.get('/guests?q=%25'))).toEqual(['100% Anić']);
    expect(names(await fd.get('/guests?q=_'))).toEqual([]);
    expect((await fd.get('/guests?q=Popović')).body[0]).toEqual({
      id: expect.any(String),
      firstName: 'Marko',
      lastName: 'Popović',
      email: 'marko@primer.rs',
      phone: null,
      language: 'sr',
      note: null,
    });
    expect((await fd.get(`/guests?q=${'a'.repeat(101)}`)).status).toBe(422);
  });

  it('housekeeping: 403 forbidden_role on GET /guests and on changes', async () => {
    const res = await fd.get('/guests?q=a', fd.housekeeping);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden_role');
    expect((await fd.post('/guests', { firstName: 'A', lastName: 'B' }, fd.housekeeping)).body.code).toBe('forbidden_role');

    // The stay-guest routes are another controller with their own @Roles.
    const booked = await bookOne({ adults: 2, children: 1 });
    const [holder] = await stayGuests(booked.stayId);
    const ana = await newGuest('Ana', 'Anić');
    expect((await fd.post(`/stays/${booked.stayId}/guests`, { guestId: ana })).status).toBe(201);
    const attempts = [
      await fd.post(`/stays/${booked.stayId}/guests`, { guest: { firstName: 'Mila', lastName: 'Milić' } }, fd.housekeeping),
      await fd.del(`/stays/${booked.stayId}/guests/${ana}`, fd.housekeeping),
      await fd.post(`/stays/${booked.stayId}/guests/${ana}/primary`, {}, fd.housekeeping),
    ];
    expect(attempts.map((r) => [r.status, r.body.code])).toEqual([
      [403, 'forbidden_role'],
      [403, 'forbidden_role'],
      [403, 'forbidden_role'],
    ]);
    expect(await stayGuests(booked.stayId)).toEqual([
      { guest_id: holder.guest_id, is_primary: true },
      { guest_id: ana, is_primary: false },
    ]);
  });

  it('ensurePrimary gives a stay without a primary guest its holder, and leaves a stay that has one', async () => {
    const booked = await bookOne({ adults: 2 });
    const [holder] = await stayGuests(booked.stayId);
    const propertyId = (await fd.sql<{ id: string }>(`SELECT id FROM property`))[0].id;
    const ensure = () =>
      fd.app.get<Db>(DB).transaction((tx) => fd.app.get(GuestsService).ensurePrimary(tx, propertyId, booked.stayId));

    // A 1a-shaped stay with no guests at all.
    await fd.sql(`DELETE FROM stay_guest WHERE stay_id = $1`, [booked.stayId]);
    await ensure();
    expect(await stayGuests(booked.stayId)).toEqual([{ guest_id: holder.guest_id, is_primary: true }]);

    // The holder is on the stay but nobody is primary.
    const ana = await newGuest('Ana', 'Anić');
    await fd.sql(`UPDATE stay_guest SET is_primary = false WHERE stay_id = $1`, [booked.stayId]);
    await fd.sql(`INSERT INTO stay_guest (property_id, stay_id, guest_id) VALUES ($1, $2, $3)`, [propertyId, booked.stayId, ana]);
    await ensure();
    expect((await stayGuests(booked.stayId)).filter((g) => g.is_primary)).toEqual([{ guest_id: holder.guest_id, is_primary: true }]);

    // Another primary guest is kept.
    await fd.sql(`UPDATE stay_guest SET is_primary = false WHERE stay_id = $1`, [booked.stayId]);
    await fd.sql(`UPDATE stay_guest SET is_primary = true WHERE stay_id = $1 AND guest_id = $2`, [booked.stayId, ana]);
    await ensure();
    expect((await stayGuests(booked.stayId)).filter((g) => g.is_primary)).toEqual([{ guest_id: ana, is_primary: true }]);
  });

  it('in safe mode GET /guests works, POST /guests is 403 safe_mode_blocked', async () => {
    const booked = await bookOne({ adults: 2 });
    fd.shiftLicence(400 * DAY_MS); // past valid_until and grace_until
    expect((await fd.get('/licence')).body.state).toBe('EXPIRED');

    const read = await fd.get('/guests?q=Petr');
    expect(read.status).toBe(200);
    expect(read.body).toHaveLength(1);
    const blocked = await fd.post('/guests', { firstName: 'Ana', lastName: 'Anić' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('safe_mode_blocked');
    expect(
      (await fd.post(`/stays/${booked.stayId}/guests`, { guest: { firstName: 'Ana', lastName: 'Anić' } })).body.code,
    ).toBe('safe_mode_blocked');
  });
});
