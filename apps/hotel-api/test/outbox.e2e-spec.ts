import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/common/audit.service';
import { MailError, NoopMailTransport, type MailMessage } from '../src/mail/mail-transport';
import { OutboxService } from '../src/mail/outbox.service';
import { createMailTransport, SmtpMailTransport } from '../src/mail/smtp.transport';
import { TEST_MAIL_FROM } from './app';
import { headerOf, startFakeSmtp, type FakeSmtp } from './fake-smtp';
import { DEFAULT_HOLDER, NOW, startFrontDesk, type FrontDesk } from './front-desk';

const MINUTE = 60_000;
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * MINUTE);
const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const NONE = { sent: 0, failed: 0, retried: 0 };

interface Row {
  id: string;
  template: string;
  recipient: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  next: Date;
  sent: Date | null;
  lease: Date | null;
}

describe('outbox: reservation e-mails (e2e)', () => {
  let fd: FrontDesk;
  let t: { typeId: string; planId: string; unitIds: string[] };

  beforeAll(async () => {
    fd = await startFrontDesk();
  });
  beforeEach(async () => {
    await fd.reset();
    t = await fd.pricedType('DBL', 3);
  });
  afterAll(() => fd.close());

  const book = (arrival = '2026-11-05', departure = '2026-11-06', holder?: object) =>
    fd.bookStay({ typeId: t.typeId, planId: t.planId }, arrival, departure, holder ? { holder } : {});
  const rows = () =>
    fd.sql<Row>(
      `SELECT id, template, recipient, status, attempts, last_error, next_attempt_at AS next, sent_at AS sent, lease_until AS lease
         FROM outbox_message ORDER BY created_at, template`,
    );
  const only = async (): Promise<Row> => {
    const r = await rows();
    expect(r).toHaveLength(1);
    return r[0];
  };
  const count = async (table: string) => (await fd.sql<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0].n;

  const cancel = (b: { reservationId: string; version: number }) =>
    fd.post(`/reservations/${b.reservationId}/cancel`, { version: b.version });
  const resendAudits = async () =>
    (await fd.sql<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'message.resend'`))[0].n;

  // ---- queuing ----

  it('booking enqueues one confirmation in the same transaction; a failed booking enqueues nothing', async () => {
    const { typeId, planId } = await fd.pricedType('SNG', 1);
    await fd.bookStay({ typeId, planId }, '2026-11-05', '2026-11-06');
    const full = await fd.post('/reservations', {
      source: 'front_desk',
      holder: { firstName: 'Ana', lastName: 'Anić', email: 'ana@example.com' },
      stays: [{ unitTypeId: typeId, arrival: '2026-11-05', departure: '2026-11-06', adults: 2, ratePlanId: planId }],
    });
    expect(full.body.code).toBe('no_availability');
    expect(await fd.sql(`SELECT template, status, recipient FROM outbox_message`)).toEqual([
      { template: 'reservation_confirmed', status: 'pending', recipient: 'petar@example.com' },
    ]);
  });

  it('the queued message is a snapshot of the booking; without a legal profile there are no property contacts', async () => {
    const b = await book('2026-11-05', '2026-11-07');
    const [property] = await fd.sql<{ name: string }>(`SELECT name FROM property`);
    const [number] = await fd.sql<{ number: string }>(`SELECT number FROM reservation WHERE id = $1`, [b.reservationId]);
    const [m] = await fd.sql<{ payload: unknown; key: string; reservation_id: string; channel: string; next: Date }>(
      `SELECT payload, idempotency_key AS key, reservation_id, channel, next_attempt_at AS next FROM outbox_message`,
    );
    expect(m.payload).toEqual({
      number: number.number,
      holderName: 'Petar Petrović',
      arrival: '2026-11-05',
      departure: '2026-11-07',
      stays: [
        { unitTypeName: 'Tip DBL', unitName: null, arrival: '2026-11-05', departure: '2026-11-07', adults: 2, children: 0, totalMinor: 2_000_000 },
      ],
      totalMinor: 2_000_000,
      propertyName: property.name,
      propertyEmail: null,
      propertyPhone: null,
    });
    expect(m.key).toBe(`reservation_confirmed:${b.reservationId}`);
    expect(m.reservation_id).toBe(b.reservationId);
    expect(m.channel).toBe('email');
    expect(iso(m.next)).toBe(NOW.toISOString()); // CLOCK, not the database's now()
  });

  it('a booking on a named unit puts the unit in the snapshot; the profile contacts reach it', async () => {
    const profile = await fd.put('/legal-profile', {
      kind: 'legal_entity', legalName: 'Demo d.o.o.', taxId: '100002887', registryId: '07036540',
      vatPayer: false, address: 'Glavna 1', postalCode: '11000', city: 'Beograd',
      email: 'recepcija@demo.example', phone: '+381 11 123 456',
    });
    expect([profile.status, profile.body.code ?? null]).toEqual([200, null]);
    await fd.bookStay({ typeId: t.typeId, planId: t.planId, unitId: t.unitIds[1] }, '2026-11-05', '2026-11-06');
    const [m] = await fd.sql<{ payload: { stays: Array<{ unitName: string }>; propertyEmail: string; propertyPhone: string } }>(
      `SELECT payload FROM outbox_message`,
    );
    expect(m.payload.stays[0].unitName).toBe('DBL-2');
    expect(m.payload.propertyEmail).toBe('recepcija@demo.example');
    expect(m.payload.propertyPhone).toBe('+381 11 123 456');
    expect(await fd.dispatcher.runOnce()).toEqual({ sent: 1, failed: 0, retried: 0 });
    expect(fd.mail.sent[0].replyTo).toBe('recepcija@demo.example');
  });

  it('an error after the message was queued takes the message back with the reservation', async () => {
    const enqueue = jest.spyOn(OutboxService.prototype, 'enqueue');
    const audit = jest.spyOn(AuditService.prototype, 'record').mockRejectedValue(new Error('injected after enqueue'));
    let status = 0;
    let enqueued = 0;
    try {
      const res = await fd.post('/reservations', {
        source: 'front_desk',
        holder: DEFAULT_HOLDER,
        stays: [{ unitTypeId: t.typeId, arrival: '2026-11-05', departure: '2026-11-06', adults: 2, ratePlanId: t.planId }],
      });
      status = res.status;
      enqueued = enqueue.mock.calls.length;
    } finally {
      audit.mockRestore();
      enqueue.mockRestore();
    }
    expect(status).toBe(500);
    expect(enqueued).toBe(1); // the message was written, then rolled back
    expect(await count('reservation')).toBe(0);
    expect(await count('outbox_message')).toBe(0);
  });

  it('enqueue with the same key twice stores one message (ON CONFLICT DO NOTHING)', async () => {
    const b = await book();
    const outbox = fd.app.get(OutboxService);
    const [m] = await fd.sql<{ property_id: string; payload: never }>(`SELECT property_id, payload FROM outbox_message`);
    await fd.ta.testDb.db.transaction((tx) =>
      outbox.enqueue(tx, m.property_id, {
        template: 'reservation_confirmed',
        reservationId: b.reservationId,
        recipient: 'drugi@example.com',
        payload: m.payload,
        key: `reservation_confirmed:${b.reservationId}`,
      }),
    );
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0].recipient).toBe('petar@example.com'); // the first one stays
  });

  it('the same channel and externalId twice: one reservation, one message', async () => {
    const body = {
      source: 'website', channel: 'booking', externalId: 'EXT-1', holder: DEFAULT_HOLDER,
      stays: [{ unitTypeId: t.typeId, arrival: '2026-11-05', departure: '2026-11-06', adults: 2, ratePlanId: t.planId }],
    };
    const first = await fd.post('/reservations', body);
    const second = await fd.post('/reservations', body);
    expect(first.status).toBe(201);
    expect(second.body.reservationId).toBe(first.body.reservationId);
    expect(await rows()).toHaveLength(1);
  });

  it('a holder without an e-mail address: skipped with the reason, and the dispatcher leaves it alone', async () => {
    await book('2026-11-05', '2026-11-06', { firstName: 'Mira', lastName: 'Mirić' });
    const m = await only();
    expect(m).toMatchObject({ status: 'skipped', recipient: null, last_error: 'Gost nema e-adresu.' });
    expect(await fd.dispatcher.runOnce()).toEqual(NONE);
    expect(fd.mail.sent).toHaveLength(0);
    expect((await only()).attempts).toBe(0);
  });

  it('cancelling adds a cancellation message; a confirmation that already went out is untouched; both have their own titles', async () => {
    const b = await book();
    expect(await fd.dispatcher.runOnce()).toEqual({ sent: 1, failed: 0, retried: 0 });
    const sentBefore = (await only()).sent;
    expect((await cancel(b)).status).toBe(200);
    const r = await rows();
    expect(r.map((x) => [x.template, x.status, x.recipient, x.last_error]).sort()).toEqual([
      ['reservation_cancelled', 'pending', 'petar@example.com', null],
      ['reservation_confirmed', 'sent', 'petar@example.com', null],
    ]);
    expect(iso(r.find((x) => x.template === 'reservation_confirmed')!.sent)).toBe(iso(sentBefore));
    const [cancelled] = await fd.sql<{ key: string }>(
      `SELECT idempotency_key AS key FROM outbox_message WHERE template = 'reservation_cancelled'`,
    );
    expect(cancelled.key).toBe(`reservation_cancelled:${b.reservationId}`);
    expect(await fd.dispatcher.runOnce()).toEqual({ sent: 1, failed: 0, retried: 0 });
    expect(fd.mail.sent.map((m) => m.subject.split(' — ')[0].replace(/ R-.*/, '')).sort()).toEqual([
      'Otkazana rezervacija',
      'Potvrda rezervacije',
    ]);
  });

  // ---- a confirmation that has not gone out is closed by the cancellation (Ruling 40) ----

  const closed = (r: Row[]) => r.map((x) => [x.template, x.status, x.last_error]).sort();
  const CANCELLED_REASON = 'Rezervacija je otkazana, pa potvrda nije poslata.';
  const titles = () => fd.mail.sent.map((m) => m.subject.split(' — ')[0].replace(/ R-.*/, ''));

  it('SMTP down at the booking, then a cancellation: only the cancellation is ever sent, however long the dispatcher runs', async () => {
    const b = await book();
    fd.mail.failNext(new MailError('smtp_down', 'Server ne odgovara.', false));
    expect(await fd.dispatcher.runOnce()).toEqual({ sent: 0, failed: 0, retried: 1 }); // the confirmation backs off
    expect((await cancel(b)).status).toBe(200);
    expect(closed(await rows())).toEqual([
      ['reservation_cancelled', 'pending', null],
      ['reservation_confirmed', 'skipped', CANCELLED_REASON],
    ]);
    let now = NOW;
    for (const minutes of [1, 5, 30, 120, 360]) {
      now = new Date(now.getTime() + minutes * MINUTE);
      fd.setNow(now);
      await fd.dispatcher.runOnce();
    }
    expect(titles()).toEqual(['Otkazana rezervacija']);
    const confirmation = (await rows()).find((x) => x.template === 'reservation_confirmed')!;
    expect(confirmation).toMatchObject({ status: 'skipped', attempts: 1, lease: null, recipient: 'petar@example.com' });
    const view = await fd.get(`/reservations/${b.reservationId}/messages`);
    expect(
      view.body.map((m: { template: string; status: string; lastError: string | null }) => [m.template, m.status, m.lastError]).sort(),
    ).toEqual([
      ['reservation_cancelled', 'sent', null],
      ['reservation_confirmed', 'skipped', CANCELLED_REASON],
    ]);
  });

  it('a confirmation that failed for good is closed by the cancellation too', async () => {
    const b = await book();
    fd.mail.failNext(new MailError('smtp_550', 'SMTP server je odbio poruku (odgovor 550).', true));
    expect(await fd.dispatcher.runOnce()).toEqual({ sent: 0, failed: 1, retried: 0 });
    expect((await cancel(b)).status).toBe(200);
    expect(closed(await rows())).toEqual([
      ['reservation_cancelled', 'pending', null],
      ['reservation_confirmed', 'skipped', CANCELLED_REASON],
    ]);
  });

  it('a cancellation closes only the confirmations of its own reservation', async () => {
    const a = await book('2026-11-05', '2026-11-06');
    await book('2026-11-08', '2026-11-09');
    expect((await cancel(a)).status).toBe(200);
    const confirmations = await fd.sql<{ status: string; reservation_id: string }>(
      `SELECT status, reservation_id FROM outbox_message WHERE template = 'reservation_confirmed'`,
    );
    expect(confirmations.map((x) => [x.reservation_id === a.reservationId, x.status]).sort()).toEqual([
      [false, 'pending'],
      [true, 'skipped'],
    ]);
  });

  it('a confirmation being sent while the reservation is cancelled is left alone', async () => {
    const b = await book();
    const hold = fd.mail.holdNext();
    const run = fd.dispatcher.runOnce();
    try {
      await Promise.race([hold.entered, delay(5_000).then(() => Promise.reject(new Error('the send never started')))]);
      expect((await cancel(b)).status).toBe(200);
      expect(closed(await rows())).toEqual([
        ['reservation_cancelled', 'pending', null],
        ['reservation_confirmed', 'sending', null],
      ]);
    } finally {
      hold.release();
    }
    expect(await run).toEqual({ sent: 1, failed: 0, retried: 0 });
    expect(closed(await rows())).toEqual([
      ['reservation_cancelled', 'pending', null],
      ['reservation_confirmed', 'sent', null],
    ]);
  });

  it('resend of a closed confirmation is 409 message_reservation_cancelled and queues nothing', async () => {
    const b = await book();
    fd.mail.failNext(new MailError('smtp_550', 'SMTP server je odbio poruku (odgovor 550).', true));
    await fd.dispatcher.runOnce();
    await cancel(b);
    const confirmation = (await rows()).find((x) => x.template === 'reservation_confirmed')!;
    const res = await fd.post(`/messages/${confirmation.id}/resend`);
    expect([res.status, res.body.code]).toEqual([409, 'message_reservation_cancelled']);
    expect(closed(await rows())).toEqual([
      ['reservation_cancelled', 'pending', null],
      ['reservation_confirmed', 'skipped', CANCELLED_REASON],
    ]);
    expect(await resendAudits()).toBe(0);
  });

  it('resend of a confirmation of a cancelled reservation is refused even when the cancellation did not close it', async () => {
    // The confirmation was being sent when the reservation was cancelled, failed meanwhile and waits for its retry.
    const b = await book();
    fd.mail.failNext(new MailError('smtp_down', 'Server ne odgovara.', false));
    const hold = fd.mail.holdNext();
    const run = fd.dispatcher.runOnce();
    try {
      await Promise.race([hold.entered, delay(5_000).then(() => Promise.reject(new Error('the send never started')))]);
      expect((await cancel(b)).status).toBe(200);
    } finally {
      hold.release();
    }
    expect(await run).toEqual({ sent: 0, failed: 0, retried: 1 });
    const confirmation = (await rows()).find((x) => x.template === 'reservation_confirmed')!;
    expect(confirmation.status).toBe('pending');
    const res = await fd.post(`/messages/${confirmation.id}/resend`);
    expect([res.status, res.body.code]).toEqual([409, 'message_reservation_cancelled']);
    expect(await resendAudits()).toBe(0);
  });

  it('resend of a failed cancellation still works (the refusal is for confirmations only)', async () => {
    const b = await book();
    await fd.dispatcher.runOnce();
    await cancel(b);
    fd.mail.failNext(new MailError('smtp_550', 'SMTP server je odbio poruku (odgovor 550).', true));
    await fd.dispatcher.runOnce();
    const failed = (await rows()).find((x) => x.template === 'reservation_cancelled')!;
    expect(failed.status).toBe('failed');
    const res = await fd.post(`/messages/${failed.id}/resend`);
    expect([res.status, res.body.status]).toEqual([200, 'pending']);
    expect(await fd.dispatcher.runOnce()).toEqual({ sent: 1, failed: 0, retried: 0 });
  });

  // ---- sending ----

  it('the dispatcher sends once, records the attempt and retries a temporary failure with backoff', async () => {
    await book();
    fd.mail.failNext(new MailError('smtp_down', 'Server ne odgovara.', false));
    expect(await fd.dispatcher.runOnce()).toEqual({ sent: 0, failed: 0, retried: 1 });
    expect(await fd.dispatcher.runOnce()).toEqual(NONE); // not due for 1 minute
    fd.setNow(new Date(NOW.getTime() + 61_000));
    expect(await fd.dispatcher.runOnce()).toEqual({ sent: 1, failed: 0, retried: 0 });
    expect(fd.mail.sent).toHaveLength(1);
    expect(fd.mail.sent[0].subject).toMatch(/^Potvrda rezervacije R-2026-000001/);
    expect(await fd.sql(`SELECT ok FROM outbox_attempt ORDER BY id`)).toEqual([{ ok: false }, { ok: true }]);
    expect(await fd.dispatcher.runOnce()).toEqual(NONE); // sent is final
    expect(fd.mail.sent).toHaveLength(1);
  });

  it('a sent message carries From, To, Reply-To (none without a profile), a stable Message-ID and the CLOCK stamps', async () => {
    await book();
    fd.setNow(at(3));
    await fd.dispatcher.runOnce();
    const m = await only();
    const sent = fd.mail.sent[0] as MailMessage;
    expect(sent.from).toBe(TEST_MAIL_FROM);
    expect(sent.to).toBe('petar@example.com');
    expect(sent.replyTo).toBeUndefined();
    expect(sent.messageId).toBe(`<${m.id}@hotel>`);
    expect(sent.text).toContain('R-2026-000001');
    expect(sent.html).toContain('<html');
    expect(m).toMatchObject({ status: 'sent', attempts: 1, last_error: null, lease: null });
    expect(iso(m.sent)).toBe(at(3).toISOString());
    const [attempt] = await fd.sql<{ at: Date; ok: boolean; error: string | null; message_id: string }>(
      `SELECT at, ok, error, message_id FROM outbox_attempt`,
    );
    expect(iso(attempt.at)).toBe(at(3).toISOString());
    expect(attempt).toMatchObject({ ok: true, error: null, message_id: m.id });
  });

  it('a retried send carries the same Message-ID as the first try', async () => {
    await book();
    fd.mail.failNext(new MailError('smtp_down', 'Server ne odgovara.', false));
    await fd.dispatcher.runOnce();
    fd.setNow(at(2));
    await fd.dispatcher.runOnce();
    const m = await only();
    expect(fd.mail.attempted.map((x) => x.messageId)).toEqual([`<${m.id}@hotel>`, `<${m.id}@hotel>`]);
  });

  it('six temporary failures end as failed; each retry waits 1, 5, 30, 120 and 360 minutes', async () => {
    await book();
    const waits = [1, 5, 30, 120, 360];
    let now = NOW;
    for (let k = 1; k <= 5; k++) {
      fd.mail.failNext(new MailError('smtp_down', 'Server ne odgovara.', false));
      expect(await fd.dispatcher.runOnce()).toEqual({ sent: 0, failed: 0, retried: 1 });
      const m = await only();
      expect(m).toMatchObject({ status: 'pending', attempts: k, last_error: 'Server ne odgovara.', lease: null });
      expect(iso(m.next)).toBe(new Date(now.getTime() + waits[k - 1] * MINUTE).toISOString());
      now = m.next;
      fd.setNow(now);
    }
    fd.mail.failNext(new MailError('smtp_down', 'Server ne odgovara.', false));
    expect(await fd.dispatcher.runOnce()).toEqual({ sent: 0, failed: 1, retried: 0 });
    expect(await only()).toMatchObject({ status: 'failed', attempts: 6, last_error: 'Server ne odgovara.' });
    expect((await fd.sql(`SELECT id FROM outbox_attempt`)).length).toBe(6);
    fd.setNow(new Date(now.getTime() + 1_000 * MINUTE));
    expect(await fd.dispatcher.runOnce()).toEqual(NONE); // failed is not taken again
  });

  it('a permanent error fails at once, with its text and no retry', async () => {
    await book();
    fd.mail.failNext(new MailError('smtp_550', 'SMTP server je odbio poruku (odgovor 550).', true));
    expect(await fd.dispatcher.runOnce()).toEqual({ sent: 0, failed: 1, retried: 0 });
    expect(await only()).toMatchObject({ status: 'failed', attempts: 1, last_error: 'SMTP server je odbio poruku (odgovor 550).' });
    fd.setNow(at(1_000));
    expect(await fd.dispatcher.runOnce()).toEqual(NONE);
  });

  it('an error that is not a MailError is stored as a generic line, never its own text', async () => {
    await book();
    fd.mail.failNext(new Error('connect to ana@example.com with password hunter2 failed'));
    expect(await fd.dispatcher.runOnce()).toEqual({ sent: 0, failed: 0, retried: 1 });
    const m = await only();
    expect(m.last_error).toBe('Slanje nije uspelo.');
    const [attempt] = await fd.sql<{ error: string }>(`SELECT error FROM outbox_attempt`);
    expect(attempt.error).toBe('Slanje nije uspelo.');
  });

  it('runOnce(limit) takes at most that many messages', async () => {
    await book('2026-11-05', '2026-11-06');
    await book('2026-11-05', '2026-11-06');
    await book('2026-11-05', '2026-11-06');
    expect(await fd.dispatcher.runOnce(2)).toEqual({ sent: 2, failed: 0, retried: 0 });
    expect(await fd.dispatcher.runOnce(2)).toEqual({ sent: 1, failed: 0, retried: 0 });
  });

  // ---- two dispatchers ----

  it('while one dispatcher is in the middle of a send, another claims nothing', async () => {
    await book();
    const other = fd.newDispatcher();
    const hold = fd.mail.holdNext();
    const first = fd.dispatcher.runOnce();
    let secondResult;
    try {
      await Promise.race([hold.entered, delay(5_000).then(() => Promise.reject(new Error('the first send never started')))]);
      expect((await only()).status).toBe('sending');
      secondResult = await other.runOnce();
    } finally {
      hold.release();
    }
    expect(secondResult).toEqual(NONE);
    expect(await first).toEqual({ sent: 1, failed: 0, retried: 0 });
    expect(fd.mail.sent).toHaveLength(1);
    expect((await only()).status).toBe('sent');
  });

  it('two dispatchers started together send the message once (a smoke test: the held-open tests above carry the race)', async () => {
    await book();
    const other = fd.newDispatcher();
    const [a, b] = await Promise.all([fd.dispatcher.runOnce(), other.runOnce()]);
    expect(a.sent + b.sent).toBe(1);
    expect(fd.mail.sent).toHaveLength(1);
  });

  it('a row another transaction holds locked is skipped, not waited for', async () => {
    await book();
    const holder = await fd.ta.testDb.pool.connect();
    let run: Promise<unknown> | undefined;
    let outcome: unknown;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM outbox_message FOR UPDATE');
      run = fd.dispatcher.runOnce();
      outcome = await Promise.race([run, delay(2_000).then(() => 'waited')]);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      if (run) await run.catch(() => undefined);
    }
    expect(outcome).toEqual(NONE);
    expect(fd.mail.sent).toHaveLength(0);
    expect((await only()).status).toBe('pending');
  });

  it('a lease that has run out is taken again; one that is still running is left alone', async () => {
    await book();
    await fd.sql(`UPDATE outbox_message SET status = 'sending', lease_until = $1`, [at(1)]);
    expect(await fd.dispatcher.runOnce()).toEqual(NONE);
    expect(await only()).toMatchObject({ status: 'sending', attempts: 0 });
    fd.setNow(at(6)); // the lease of a claim at NOW would have ended at NOW + 5 minutes
    expect(await fd.dispatcher.runOnce()).toEqual({ sent: 1, failed: 0, retried: 0 });
    expect((await only()).status).toBe('sent');
  });

  it('a claim leases the message for 5 minutes of CLOCK time', async () => {
    await book();
    const hold = fd.mail.holdNext();
    const run = fd.dispatcher.runOnce();
    try {
      await Promise.race([hold.entered, delay(5_000).then(() => Promise.reject(new Error('the send never started')))]);
      expect(iso((await only()).lease)).toBe(at(5).toISOString());
    } finally {
      hold.release();
    }
    await run;
  });

  // A dispatcher whose lease ran out while it was sending: the other run that took the message over finishes first,
  // and the late result must neither count again nor write over the final state (each result write is guarded).
  it.each([
    ['success', null],
    ['permanent failure', new MailError('smtp_550', 'SMTP server je odbio poruku (odgovor 550).', true)],
    ['temporary failure', new MailError('smtp_down', 'Server ne odgovara.', false)],
  ])('a late %s of a run whose lease ran out is dropped: not counted, no attempt row, state untouched', async (_name, lateError) => {
    await book();
    const other = fd.newDispatcher();
    const hold = fd.mail.holdNext();
    const slow = fd.dispatcher.runOnce();
    let lateResult;
    try {
      await Promise.race([hold.entered, delay(5_000).then(() => Promise.reject(new Error('the first send never started')))]);
      fd.setNow(at(6)); // the lease of the claim at NOW ended at NOW + 5 minutes
      expect(await other.runOnce()).toEqual({ sent: 1, failed: 0, retried: 0 });
      if (lateError) fd.mail.failNext(lateError); // after the other run's send, which would have taken it
    } finally {
      hold.release();
      lateResult = await slow;
    }
    expect(lateResult).toEqual(NONE);
    expect(await only()).toMatchObject({ status: 'sent', attempts: 1, last_error: null, lease: null });
    expect(await fd.sql(`SELECT ok FROM outbox_attempt`)).toEqual([{ ok: true }]);
  });

  // ---- reading and resending ----

  it('GET /reservations/:id/messages lists the messages with their attempts and writes nothing', async () => {
    const b = await book();
    fd.mail.failNext(new MailError('smtp_down', 'Server ne odgovara.', false));
    await fd.dispatcher.runOnce();
    fd.setNow(new Date(NOW.getTime() + 61_000));
    await fd.dispatcher.runOnce();
    const before = JSON.stringify([await rows(), await count('audit_log'), await count('outbox_attempt')]);
    const res = await fd.get(`/reservations/${b.reservationId}/messages`);
    expect(res.status).toBe(200);
    const m = await only();
    expect(res.body).toEqual([
      {
        id: m.id,
        template: 'reservation_confirmed',
        recipient: 'petar@example.com',
        status: 'sent',
        attempts: 2,
        lastError: null,
        nextAttemptAt: at(1).toISOString(),
        sentAt: new Date(NOW.getTime() + 61_000).toISOString(),
        history: [
          { at: NOW.toISOString(), ok: false, error: 'Server ne odgovara.' },
          { at: new Date(NOW.getTime() + 61_000).toISOString(), ok: true, error: null },
        ],
      },
    ]);
    expect(JSON.stringify([await rows(), await count('audit_log'), await count('outbox_attempt')])).toBe(before);
  });

  it('GET messages: a skipped message shows its reason; an unknown or malformed reservation is 404', async () => {
    const b = await book('2026-11-05', '2026-11-06', { firstName: 'Mira', lastName: 'Mirić' });
    const res = await fd.get(`/reservations/${b.reservationId}/messages`);
    expect(res.body).toMatchObject([{ status: 'skipped', recipient: null, lastError: 'Gost nema e-adresu.', history: [] }]);
    const other = await book('2026-11-08', '2026-11-09');
    expect((await fd.get(`/reservations/${other.reservationId}/messages`)).body).toHaveLength(1); // only its own
    const unknown = await fd.get(`/reservations/${randomUUID()}/messages`);
    expect([unknown.status, unknown.body.code]).toEqual([404, 'reservation_not_found']);
    const malformed = await fd.get('/reservations/not-a-uuid/messages');
    expect([malformed.status, malformed.body.code]).toEqual([404, 'reservation_not_found']);
  });

  it('GET messages: two messages of one reservation each show only their own attempts', async () => {
    const b = await book();
    fd.mail.failNext(new MailError('smtp_a', 'Prva greška.', false));
    await fd.dispatcher.runOnce();
    fd.setNow(at(2));
    await fd.dispatcher.runOnce(); // the confirmation is sent on its second attempt
    expect((await cancel(b)).status).toBe(200);
    fd.mail.failNext(new MailError('smtp_b', 'Druga greška.', false));
    await fd.dispatcher.runOnce();
    fd.setNow(at(4));
    await fd.dispatcher.runOnce(); // the cancellation is sent on its second attempt
    const res = await fd.get(`/reservations/${b.reservationId}/messages`);
    expect(res.status).toBe(200);
    expect(
      res.body.map((m: { template: string; status: string; history: Array<{ ok: boolean; error: string | null }> }) => [
        m.template,
        m.status,
        m.history.map((h) => [h.ok, h.error]),
      ]),
    ).toEqual([
      ['reservation_confirmed', 'sent', [[false, 'Prva greška.'], [true, null]]],
      ['reservation_cancelled', 'sent', [[false, 'Druga greška.'], [true, null]]],
    ]);
  });

  it('a resend that meets a claim in flight waits for it and leaves the message alone (row lock)', async () => {
    await book();
    const m = await only();
    const claimer = await fd.ta.testDb.pool.connect();
    let open = false;
    let resend: Promise<{ status: number; body: { status?: string } }> | undefined;
    try {
      await claimer.query('BEGIN');
      open = true;
      // What the dispatcher's claim does, held open: the message is 'sending' but not yet committed.
      await claimer.query(`UPDATE outbox_message SET status = 'sending', lease_until = $1 WHERE id = $2`, [at(5), m.id]);
      resend = fd.post(`/messages/${m.id}/resend`).then((r) => r);
      const deadline = Date.now() + 5_000;
      for (;;) {
        const [w] = await fd.sql<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if (w.n > 0) break;
        if (Date.now() > deadline) throw new Error('the resend never waited for the claim');
        await delay(25);
      }
      await claimer.query('COMMIT');
      open = false;
    } finally {
      if (open) await claimer.query('ROLLBACK');
      claimer.release();
    }
    const res = await Promise.race([resend, delay(5_000).then(() => Promise.reject(new Error('the resend never finished')))]);
    expect([res.status, res.body.status]).toEqual([200, 'sending']);
    const after = await only();
    expect(after.status).toBe('sending'); // not moved back to pending
    expect(iso(after.lease)).toBe(at(5).toISOString());
    expect(await resendAudits()).toBe(0);
    expect(await fd.dispatcher.runOnce()).toEqual(NONE); // no second run picks it up
    expect(fd.mail.sent).toHaveLength(0);
  });

  it('resend puts a failed message back, due now, and the next run sends it; an audit row names who did it', async () => {
    await book();
    fd.mail.failNext(new MailError('smtp_550', 'SMTP server je odbio poruku (odgovor 550).', true));
    await fd.dispatcher.runOnce();
    const failed = await only();
    fd.setNow(at(10));
    const res = await fd.post(`/messages/${failed.id}/resend`, {}, fd.manager);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: failed.id, status: 'pending', attempts: 1, nextAttemptAt: at(10).toISOString() });
    expect(res.body.history).toHaveLength(1);
    expect(await fd.sql(`SELECT action, entity, entity_id, actor_user_id, before, after FROM audit_log WHERE action = 'message.resend'`)).toEqual([
      {
        action: 'message.resend',
        entity: 'outbox_message',
        entity_id: failed.id,
        actor_user_id: fd.managerId,
        before: { status: 'failed', attempts: 1 },
        after: { status: 'pending' },
      },
    ]);
    expect(await fd.dispatcher.runOnce()).toEqual({ sent: 1, failed: 0, retried: 0 });
    expect(await only()).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('resend of a waiting message makes it due now', async () => {
    await book();
    fd.mail.failNext(new MailError('smtp_down', 'Server ne odgovara.', false));
    await fd.dispatcher.runOnce();
    const waiting = await only();
    expect(iso(waiting.next)).toBe(at(1).toISOString());
    expect(await fd.dispatcher.runOnce()).toEqual(NONE);
    const res = await fd.post(`/messages/${waiting.id}/resend`);
    expect(res.status).toBe(200);
    expect(iso((await only()).next)).toBe(NOW.toISOString());
    expect(await fd.dispatcher.runOnce()).toEqual({ sent: 1, failed: 0, retried: 0 });
  });

  it('resend of a sent message is 409 message_already_sent and changes nothing', async () => {
    await book();
    await fd.dispatcher.runOnce();
    const sent = await only();
    const res = await fd.post(`/messages/${sent.id}/resend`);
    expect([res.status, res.body.code]).toEqual([409, 'message_already_sent']);
    expect(await only()).toMatchObject({ status: 'sent', attempts: 1 });
    expect(await resendAudits()).toBe(0);
    expect(fd.mail.sent).toHaveLength(1);
  });

  it('resend of a message without a recipient is 409 message_has_no_recipient', async () => {
    await book('2026-11-05', '2026-11-06', { firstName: 'Mira', lastName: 'Mirić' });
    const skipped = await only();
    const res = await fd.post(`/messages/${skipped.id}/resend`);
    expect([res.status, res.body.code]).toEqual([409, 'message_has_no_recipient']);
    expect((await only()).status).toBe('skipped');
  });

  it('resend of a message being sent right now leaves it alone', async () => {
    await book();
    const m = await only();
    await fd.sql(`UPDATE outbox_message SET status = 'sending', lease_until = $1, next_attempt_at = $2`, [at(4), at(-3)]);
    const res = await fd.post(`/messages/${m.id}/resend`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('sending');
    const after = await only();
    expect(after.status).toBe('sending');
    expect(iso(after.next)).toBe(at(-3).toISOString());
    expect(await resendAudits()).toBe(0);
  });

  it('resend of an unknown or malformed message id is 404 message_not_found', async () => {
    const unknown = await fd.post(`/messages/${randomUUID()}/resend`);
    expect([unknown.status, unknown.body.code]).toEqual([404, 'message_not_found']);
    const malformed = await fd.post('/messages/not-a-uuid/resend');
    expect([malformed.status, malformed.body.code]).toEqual([404, 'message_not_found']);
  });

  // ---- who may ----

  it('housekeeping gets forbidden_role on both message routes; receptionist, manager and owner pass', async () => {
    const b = await book();
    await fd.dispatcher.runOnce();
    const m = await only();
    for (const res of [
      await fd.get(`/reservations/${b.reservationId}/messages`, fd.housekeeping),
      await fd.post(`/messages/${m.id}/resend`, {}, fd.housekeeping),
    ]) {
      expect([res.status, res.body.code]).toEqual([403, 'forbidden_role']);
    }
    for (const cookie of [fd.receptionist, fd.manager, fd.owner]) {
      expect((await fd.get(`/reservations/${b.reservationId}/messages`, cookie)).status).toBe(200);
      expect((await fd.post(`/messages/${m.id}/resend`, {}, cookie)).status).toBe(409); // sent: passed the guards
    }
  });

  it('both message routes belong to hotel.core, not hotel.folio', async () => {
    await fd.reset({ modules: ['hotel.folio'] });
    const get = await fd.get(`/reservations/${randomUUID()}/messages`);
    expect([get.status, get.body.code]).toEqual([403, 'module_not_licensed']);
    const post = await fd.post(`/messages/${randomUUID()}/resend`);
    expect([post.status, post.body.code]).toEqual([403, 'module_not_licensed']);
  });

  it('in safe mode the messages can be read, not resent', async () => {
    const b = await book();
    await fd.dispatcher.runOnce();
    const m = await only();
    fd.shiftLicence(400 * 86_400_000);
    expect((await fd.get(`/reservations/${b.reservationId}/messages`)).status).toBe(200);
    const res = await fd.post(`/messages/${m.id}/resend`);
    expect([res.status, res.body.code]).toEqual([403, 'safe_mode_blocked']);
  });
});

describe('outbox without SMTP settings (e2e)', () => {
  let fd: FrontDesk;

  beforeAll(async () => {
    fd = await startFrontDesk({ mail: new NoopMailTransport() });
  });
  beforeEach(() => fd.reset());
  afterAll(() => fd.close());

  it('the Noop transport records the failure "SMTP nije podešen." and the message stays visible', async () => {
    const { typeId, planId } = await fd.pricedType('DBL', 1);
    const b = await fd.bookStay({ typeId, planId }, '2026-11-05', '2026-11-06');
    expect(await fd.dispatcher.runOnce()).toEqual({ sent: 0, failed: 0, retried: 1 });
    expect(await fd.sql(`SELECT ok, error FROM outbox_attempt`)).toEqual([{ ok: false, error: 'SMTP nije podešen.' }]);
    const res = await fd.get(`/reservations/${b.reservationId}/messages`);
    expect(res.body).toMatchObject([
      { status: 'pending', attempts: 1, lastError: 'SMTP nije podešen.', history: [{ ok: false, error: 'SMTP nije podešen.' }] },
    ]);
  });
});

describe('mail configuration', () => {
  // What nodemailer was given: Mailer keeps the options of createTransport.
  const optionsOf = (t: unknown) =>
    (t as { transporter: { options: Record<string, unknown> } }).transporter.options as Record<string, unknown> & { auth?: unknown };
  const secrets = { SMTP_HOST: 'smtp.private.example', SMTP_USER: 'robot-user', SMTP_PASSWORD: 'p4ssw0rd-secret', MAIL_FROM: 'Hotel <hotel@private.example>' };

  it('without SMTP_HOST: Noop and one log line that names the variable, not a value', () => {
    const lines: string[] = [];
    const transport = createMailTransport({ ...secrets, SMTP_HOST: undefined }, (l) => lines.push(l));
    expect(transport).toBeInstanceOf(NoopMailTransport);
    expect(transport.configured).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('SMTP_HOST');
    for (const v of Object.values(secrets)) if (v) expect(lines[0]).not.toContain(v);
  });

  it('without MAIL_FROM: Noop and one log line without values', () => {
    const lines: string[] = [];
    const transport = createMailTransport({ ...secrets, MAIL_FROM: ' ' }, (l) => lines.push(l));
    expect(transport).toBeInstanceOf(NoopMailTransport);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('MAIL_FROM');
    for (const v of Object.values(secrets)) expect(lines[0]).not.toContain(v);
  });

  it.each(['abc', '0', '70000', '25.5'])('SMTP_PORT %s is refused: Noop and one log line', (port) => {
    const lines: string[] = [];
    const transport = createMailTransport({ ...secrets, SMTP_PORT: port }, (l) => lines.push(l));
    expect(transport).toBeInstanceOf(NoopMailTransport);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('SMTP_PORT');
    for (const v of Object.values(secrets)) expect(lines[0]).not.toContain(v);
  });

  it('with host and sender set: an SMTP transport and no log line (port defaults to 587)', () => {
    const lines: string[] = [];
    const transport = createMailTransport(secrets, (l) => lines.push(l));
    expect(transport).toBeInstanceOf(SmtpMailTransport);
    expect(transport.configured).toBe(true);
    expect(lines).toEqual([]);
    expect(optionsOf(transport)).toMatchObject({ host: 'smtp.private.example', port: 587, secure: false, connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 20_000 });
    expect(optionsOf(transport).auth).toEqual({ user: 'robot-user', pass: 'p4ssw0rd-secret' });
  });

  it('SMTP_PORT, SMTP_SECURE=true and a missing user are passed on as set', () => {
    const transport = createMailTransport({ SMTP_HOST: 'h.example', MAIL_FROM: 'a@b.example', SMTP_PORT: '465', SMTP_SECURE: 'TRUE' }, () => undefined);
    expect(optionsOf(transport)).toMatchObject({ host: 'h.example', port: 465, secure: true });
    expect(optionsOf(transport).auth).toBeUndefined();
  });
});

describe('SmtpMailTransport against a local SMTP server', () => {
  let smtp: FakeSmtp;
  const message: MailMessage = {
    to: 'gost@example.com',
    from: 'Demo Hotel <hotel@example.test>',
    replyTo: 'recepcija@example.test',
    subject: 'Test subject',
    text: 'Telo poruke',
    html: '<p>Telo poruke</p>',
    messageId: '<abc-123@hotel>',
  };
  const transportOn = (port: number) => new SmtpMailTransport({ host: '127.0.0.1', port, secure: false });
  const failure = async (port: number): Promise<MailError> => {
    try {
      await transportOn(port).send(message);
    } catch (err) {
      return err as MailError;
    }
    throw new Error('the send was expected to fail');
  };

  beforeEach(async () => {
    smtp = await startFakeSmtp();
  });
  afterEach(() => smtp.close());

  it('delivers the message with From, To, Reply-To, Subject and Message-ID', async () => {
    await transportOn(smtp.port).send(message);
    expect(smtp.received).toHaveLength(1);
    const got = smtp.received[0];
    expect(got.from).toBe('hotel@example.test');
    expect(got.to).toEqual(['gost@example.com']);
    expect(headerOf(got.data, 'From')).toContain('hotel@example.test');
    expect(headerOf(got.data, 'To')).toContain('gost@example.com');
    expect(headerOf(got.data, 'Reply-To')).toContain('recepcija@example.test');
    expect(headerOf(got.data, 'Subject')).toBe('Test subject');
    expect(headerOf(got.data, 'Message-ID')).toBe('<abc-123@hotel>');
    expect(got.data).toContain('text/html');
  });

  it('a 5xx answer is a permanent MailError with fixed text, not the server\'s words', async () => {
    smtp.rejectRecipients(550, 'mailbox gost@example.com unavailable, password p4ssw0rd-secret');
    const err = await failure(smtp.port);
    expect(err).toBeInstanceOf(MailError);
    expect(err).toMatchObject({ code: 'smtp_550', permanent: true, message: 'SMTP server je odbio poruku (odgovor 550).' });
  });

  it('a 4xx answer is a temporary MailError', async () => {
    smtp.rejectRecipients(451, 'try again later');
    const err = await failure(smtp.port);
    expect(err).toMatchObject({ code: 'smtp_451', permanent: false, message: 'SMTP server trenutno ne prima poruku (odgovor 451).' });
  });

  it('a server that is not there is a temporary MailError', async () => {
    const gone = await startFakeSmtp();
    const port = gone.port;
    await gone.close();
    const err = await failure(port);
    expect(err).toMatchObject({ code: 'smtp_connection', permanent: false, message: 'Veza sa SMTP serverom nije uspela.' });
  });
});
