import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { LicensePayload } from '@platform/licensing';
import request from 'supertest';
import { ActivationService } from '../src/licensing/activation.service';
import { CentralAdminClient } from '../src/licensing/central-admin.client';
import { LicenceService } from '../src/licensing/licence.service';
import { parseRootKeySet } from '../src/licensing/licensing.config';
import { SecretBox } from '../src/licensing/secret-box';
import { createTestApp, type TestApp } from './app';
import { seedUser, sessionCookieFor } from './auth-helpers';
import { startFakeCentralAdmin, type FakeCentralAdmin } from './fake-central-admin';

// The shared harness of the phase 1b e2e specs: one app with a movable clock,
// a licence from the fake Central Admin, four signed-in roles and helpers
// that price and book through the API. Built on the helpers of
// test/reservations.e2e-spec.ts (that spec is left as it is).

export const NOW = new Date('2026-11-02T08:00:00Z'); // 09:00 Belgrade; the property's "today" is 2026-11-02
export const DAY_MS = 86_400_000;

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
  /** A query on the test database (outside the app). */
  sql<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export const DEFAULT_HOLDER = { firstName: 'Petar', lastName: 'Petrović', email: 'petar@example.com' };

export async function startFrontDesk(): Promise<FrontDesk> {
  const fake = await startFakeCentralAdmin();
  let now = NOW;
  let licenceShiftMs = 0;
  let planId: string | null = null;
  const ta = await createTestApp({
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
    setNow(at) {
      now = at;
    },
    shiftLicence(ms) {
      licenceShiftMs = ms;
    },
    async reset(licence = {}) {
      now = NOW;
      licenceShiftMs = 0;
      planId = null;
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
      fd.owner = (await cookie('owner')).cookie;
      const m = await cookie('manager');
      fd.manager = m.cookie;
      fd.managerId = m.id;
      fd.receptionist = (await cookie('receptionist')).cookie;
      fd.housekeeping = (await cookie('housekeeping')).cookie;
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
