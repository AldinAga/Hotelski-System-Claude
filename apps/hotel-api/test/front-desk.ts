import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { LicensePayload } from '@platform/licensing';
import request from 'supertest';
import { BusinessDayService } from '../src/business-day/business-day.service';
import { PropertyContext } from '../src/common/property-context';
import { DB } from '../src/db/tokens';
import { ActivationService } from '../src/licensing/activation.service';
import { CentralAdminClient } from '../src/licensing/central-admin.client';
import { LicenceService } from '../src/licensing/licence.service';
import { parseRootKeySet } from '../src/licensing/licensing.config';
import { SecretBox } from '../src/licensing/secret-box';
import type { MailMessage, MailTransport } from '../src/mail/mail-transport';
import { OutboxDispatcher } from '../src/mail/outbox.dispatcher';
import { createTestApp, TEST_MAIL_FROM, type TestApp } from './app';
import { seedUser, sessionCookieFor } from './auth-helpers';
import { startFakeCentralAdmin, type FakeCentralAdmin } from './fake-central-admin';

// The shared harness of the phase 1b e2e specs: one app with a movable clock,
// a licence from the fake Central Admin, four signed-in roles and helpers
// that price and book through the API. Built on the helpers of
// test/reservations.e2e-spec.ts (that spec is left as it is).

export const NOW = new Date('2026-11-02T08:00:00Z'); // 09:00 Belgrade; the property's "today" is 2026-11-02
export const DAY_MS = 86_400_000;

/**
 * A mail transport that records what it sends. failNext queues errors thrown by
 * the next sends (in order); holdNext makes the next send wait until released,
 * to freeze a dispatcher in the middle of a send.
 */
export class FakeMailTransport implements MailTransport {
  readonly configured = true;
  /** Messages delivered. */
  readonly sent: MailMessage[] = [];
  /** Every message handed to send, failed ones included. */
  readonly attempted: MailMessage[] = [];
  private failures: Error[] = [];
  private holds: Array<{ entered: () => void; gate: Promise<void> }> = [];

  failNext(err: Error): void {
    this.failures.push(err);
  }

  holdNext(): { entered: Promise<void>; release: () => void } {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    const gate = new Promise<void>((r) => (release = r));
    this.holds.push({ entered: enter, gate });
    return { entered, release };
  }

  async send(m: MailMessage): Promise<void> {
    const hold = this.holds.shift();
    if (hold) {
      hold.entered();
      await hold.gate;
    }
    this.attempted.push(m);
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push(m);
  }

  clear(): void {
    this.sent.length = 0;
    this.attempted.length = 0;
    this.failures = [];
    this.holds = [];
  }
}

export interface Target {
  typeId: string;
  planId: string;
  unitId?: string;
}

export interface FrontDesk {
  ta: TestApp;
  app: INestApplication;
  fake: FakeCentralAdmin;
  /** Session cookies. */
  owner: string;
  manager: string;
  receptionist: string;
  housekeeping: string;
  managerId: string;
  /** The application clock (CLOCK). */
  setNow(at: Date): void;
  /**
   * Moves the application clock and signs the four roles in again: sessions
   * run on CLOCK and expire after 12 idle hours, so a test that moves the
   * clock past that needs fresh cookies (same users).
   */
  travel(at: Date): Promise<void>;
  /** The recording mail transport the app sends through (unless startFrontDesk got its own `mail`). */
  mail: FakeMailTransport;
  /** The app's own dispatcher (no timer runs it in tests). */
  dispatcher: OutboxDispatcher;
  /** Another dispatcher on the same database and clock, as a second process would be. */
  newDispatcher(transport?: MailTransport): OutboxDispatcher;
  /** The licence clock, for safe mode: shiftLicence(400 * DAY_MS) is past valid_until and grace_until. */
  shiftLicence(ms: number): void;
  /**
   * Empties the database, sets the clocks back to NOW and activates a licence
   * with modules hotel.core and hotel.folio, limits { rooms: 20, users: 10 },
   * expiry_mode 'safe_mode', merged with `licence`; then seeds the four roles.
   */
  reset(licence?: Partial<LicensePayload>): Promise<void>;
  /** Default cookie: receptionist. */
  get(path: string, cookie?: string): request.Test;
  post(path: string, body?: object, cookie?: string): request.Test;
  /** Default cookie: manager. */
  put(path: string, body?: object, cookie?: string): request.Test;
  /** Default cookie: manager. */
  patch(path: string, body?: object, cookie?: string): request.Test;
  /** Default cookie: receptionist. */
  del(path: string, cookie?: string): request.Test;
  /**
   * A unit type with `units` units, priced on plan 'BAR' (one per reset) for
   * 2026-11-01..2028-03-01 at `priceMinor` (default 1_000_000 = 10.000,00 RSD).
   */
  pricedType(code: string, units: number, priceMinor?: number): Promise<{ typeId: string; unitIds: string[]; planId: string }>;
  /** Books one stay through POST /reservations (holder Petar Petrović, 2 adults, front_desk). */
  bookStay(
    t: Target,
    arrival: string,
    departure: string,
    extra?: { holder?: object; adults?: number; children?: number },
  ): Promise<{ reservationId: string; stayId: string; version: number }>;
  /**
   * Books one stay on `t.unitId` (required) and checks it in through
   * POST /stays/:id/check-in; `version` is the reservation's after check-in.
   */
  inHouse(t: Target, arrival: string, departure: string): Promise<{ reservationId: string; stayId: string; version: number }>;
  /**
   * Fires `n` requests while the test holds the open business day FOR UPDATE, waits
   * until all `n` wait on a lock, then releases it: every request then races for the
   * rows behind the day at once (Ruling 27). The wait races a deadline (Ruling 27a)
   * and the day is released in finally (Ruling 28). Opens the day first when needed.
   */
  raceUnderHeldDay<T>(n: number, fire: () => Array<PromiseLike<T>>): Promise<T[]>;
  /** A query on the test database (outside the app). */
  sql<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export const DEFAULT_HOLDER = { firstName: 'Petar', lastName: 'Petrović', email: 'petar@example.com' };

/** `poolMax`: the app's pool client limit, for suites whose race tests hold more than nine transactions (Ruling 27a). */
export async function startFrontDesk(opts: { poolMax?: number; mail?: MailTransport } = {}): Promise<FrontDesk> {
  const fake = await startFakeCentralAdmin();
  let now = NOW;
  let licenceShiftMs = 0;
  let planId: string | null = null;
  let userIds: Record<'owner' | 'manager' | 'receptionist' | 'housekeeping', string> | null = null;
  const mail = new FakeMailTransport();
  const ta = await createTestApp({
    poolMax: opts.poolMax,
    mail: opts.mail ?? mail,
    clock: () => now,
    licensing: {
      client: new CentralAdminClient({ baseUrl: fake.url, allowHttp: true }),
      rootKeySet: parseRootKeySet(JSON.stringify(fake.rootKeySet)),
      secretBox: new SecretBox(randomBytes(32)),
      now: () => new Date(Date.now() + licenceShiftMs),
    },
  });
  const app = ta.app;
  const server = () => app.getHttpServer();

  const fd: FrontDesk = {
    ta,
    app,
    fake,
    owner: '',
    manager: '',
    receptionist: '',
    housekeeping: '',
    managerId: '',
    mail,
    dispatcher: app.get(OutboxDispatcher),
    newDispatcher: (transport = mail) => new OutboxDispatcher(app.get(DB), () => now, transport, TEST_MAIL_FROM),
    setNow(at) {
      now = at;
    },
    async travel(at) {
      now = at;
      if (!userIds) throw new Error('front-desk: travel before reset');
      fd.owner = await sessionCookieFor(app, userIds.owner);
      fd.manager = await sessionCookieFor(app, userIds.manager);
      fd.receptionist = await sessionCookieFor(app, userIds.receptionist);
      fd.housekeeping = await sessionCookieFor(app, userIds.housekeeping);
    },
    shiftLicence(ms) {
      licenceShiftMs = ms;
    },
    async reset(licence = {}) {
      now = NOW;
      licenceShiftMs = 0;
      planId = null;
      mail.clear();
      await ta.reset();
      await app.get(ActivationService).activate(
        fake.issueCode({
          licence: {
            modules: ['hotel.core', 'hotel.folio'],
            limits: { rooms: 20, users: 10 },
            expiry_mode: 'safe_mode',
            ...licence,
          },
        }),
      );
      await app.get(LicenceService).reload();
      const cookie = async (role: 'owner' | 'manager' | 'receptionist' | 'housekeeping') => {
        const u = await seedUser(ta.testDb, role);
        return { id: u.id, cookie: await sessionCookieFor(app, u.id) };
      };
      const o = await cookie('owner');
      fd.owner = o.cookie;
      const m = await cookie('manager');
      fd.manager = m.cookie;
      fd.managerId = m.id;
      const r = await cookie('receptionist');
      fd.receptionist = r.cookie;
      const h = await cookie('housekeeping');
      fd.housekeeping = h.cookie;
      userIds = { owner: o.id, manager: m.id, receptionist: r.id, housekeeping: h.id };
    },
    get: (path, cookie = fd.receptionist) => request(server()).get(path).set('Cookie', cookie),
    post: (path, body = {}, cookie = fd.receptionist) => request(server()).post(path).set('Cookie', cookie).send(body),
    put: (path, body = {}, cookie = fd.manager) => request(server()).put(path).set('Cookie', cookie).send(body),
    patch: (path, body = {}, cookie = fd.manager) => request(server()).patch(path).set('Cookie', cookie).send(body),
    del: (path, cookie = fd.receptionist) => request(server()).delete(path).set('Cookie', cookie),

    async pricedType(code, units, priceMinor = 1_000_000) {
      if (!planId) {
        const plan = await fd.post('/rate-plans', { code: 'BAR', name: { sr: 'Osnovna cena' } }, fd.manager);
        if (plan.status !== 201) throw new Error(`front-desk: rate plan ${plan.status} ${JSON.stringify(plan.body)}`);
        planId = plan.body.id as string;
      }
      const type = await fd.post('/unit-types', { code, name: { sr: `Tip ${code}` }, capacity: 3 }, fd.manager);
      if (type.status !== 201) throw new Error(`front-desk: unit type ${type.status} ${JSON.stringify(type.body)}`);
      const typeId = type.body.id as string;
      const unitIds: string[] = [];
      for (let i = 1; i <= units; i++) {
        const unit = await fd.post('/units', { name: `${code}-${i}`, unitTypeId: typeId }, fd.manager);
        if (unit.status !== 201) throw new Error(`front-desk: unit ${unit.status} ${JSON.stringify(unit.body)}`);
        unitIds.push(unit.body.id as string);
      }
      const priced = await fd.put(`/rate-plans/${planId}/days`, {
        scope: { kind: 'unit_type', id: typeId },
        from: '2026-11-01',
        to: '2028-03-01',
        priceMinor,
      });
      if (priced.status !== 200) throw new Error(`front-desk: price ${priced.status} ${JSON.stringify(priced.body)}`);
      return { typeId, unitIds, planId };
    },

    async bookStay(t, arrival, departure, extra = {}) {
      const target = t.unitId ? { unitId: t.unitId } : { unitTypeId: t.typeId };
      const res = await fd.post('/reservations', {
        source: 'front_desk',
        holder: extra.holder ?? DEFAULT_HOLDER,
        stays: [
          { ...target, arrival, departure, adults: extra.adults ?? 2, children: extra.children ?? 0, ratePlanId: t.planId },
        ],
      });
      if (res.status !== 201) throw new Error(`front-desk: book ${res.status} ${JSON.stringify(res.body)}`);
      const reservationId = res.body.reservationId as string;
      const rows = await fd.sql<{ stay_id: string; version: number }>(
        `SELECT s.id AS stay_id, r.version FROM reservation r JOIN stay s ON s.reservation_id = r.id WHERE r.id = $1`,
        [reservationId],
      );
      return { reservationId, stayId: rows[0].stay_id, version: rows[0].version };
    },

    async inHouse(t, arrival, departure) {
      if (!t.unitId) throw new Error('front-desk: inHouse needs a unitId (check-in requires a unit)');
      const b = await fd.bookStay(t, arrival, departure);
      const res = await fd.post(`/stays/${b.stayId}/check-in`, { version: b.version });
      if (res.status !== 200) throw new Error(`front-desk: check-in ${res.status} ${JSON.stringify(res.body)}`);
      return { ...b, version: res.body.version as number };
    },

    async raceUnderHeldDay<T>(n: number, fire: () => Array<PromiseLike<T>>): Promise<T[]> {
      const pid = await app.get(PropertyContext).id();
      const days = app.get(BusinessDayService);
      await ta.testDb.db.transaction((tx) => days.lockOpen(tx, pid, 'share')); // the day row exists, committed
      const holder = await ta.testDb.pool.connect();
      let all: Promise<T[]> | null = null;
      let waitError: unknown = null;
      try {
        await holder.query('BEGIN');
        const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        await holder.query(`SELECT 1 FROM business_day WHERE property_id = $1 AND status = 'open' FOR UPDATE`, [pid]);
        all = Promise.all(fire());
        const deadline = Date.now() + 5_000;
        for (;;) {
          const [{ waiting }] = await fd.sql<{ waiting: number }>(
            `SELECT count(*)::int AS waiting FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`,
            [rows[0].pid],
          );
          if (waiting >= n) break;
          if (Date.now() > deadline) throw new Error(`barrier: only ${waiting} of ${n} requests waited on the business day`);
          await new Promise<void>((r) => setTimeout(r, 20));
        }
      } catch (err) {
        waitError = err;
      } finally {
        await holder.query('COMMIT');
        holder.release();
      }
      const results = all ? await all : [];
      if (waitError) throw waitError;
      return results;
    },

    async sql<T>(text: string, params?: unknown[]) {
      return (await ta.testDb.pool.query(text, params)).rows as T[];
    },

    async close() {
      await app.close();
      await fake.close();
    },
  };
  return fd;
}
