import type { INestApplication } from '@nestjs/common';
import type { Response } from 'supertest';
import { hashPassword } from '../src/auth/password';
import { SessionsService } from '../src/auth/sessions.service';
import { newTotpSecret } from '../src/auth/totp';
import type { TotpState, UserRole } from '../src/db/schema';
import type { TestDb } from './db';

export const PASSWORD = 'tacna-lozinka-123';

export interface SeededUser {
  id: string;
  email: string;
  password: string;
  role: UserRole;
  totpSecret: string | null;
}

/** The installation's property, created on first use (there is only ever one). */
export async function ensureProperty(t: TestDb): Promise<string> {
  const existing = await t.pool.query<{ id: string }>('SELECT id FROM property LIMIT 1');
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await t.pool.query<{ id: string }>(`INSERT INTO property (name) VALUES ('Test hotel') RETURNING id`);
  return created.rows[0].id;
}

/**
 * Inserts a user directly. Owners and managers get a TOTP secret that is
 * already armed ('confirmed') unless `totpState` says otherwise.
 */
export async function seedUser(
  t: TestDb,
  role: UserRole,
  opts: { email?: string; password?: string; active?: boolean; totpState?: TotpState } = {},
): Promise<SeededUser> {
  const propertyId = await ensureProperty(t);
  const email = opts.email ?? `${role}-${Math.random().toString(36).slice(2, 8)}@hotel.test`;
  const password = opts.password ?? PASSWORD;
  const totpState = opts.totpState ?? (role === 'owner' || role === 'manager' ? 'confirmed' : 'none');
  const totpSecret = totpState === 'none' ? null : newTotpSecret();
  const { rows } = await t.pool.query<{ id: string }>(
    `INSERT INTO app_user (property_id, email, name, role, password_hash, totp_secret, totp_state, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [propertyId, email, `Ime ${role}`, role, await hashPassword(password), totpSecret, totpState, opts.active ?? true],
  );
  return { id: rows[0].id, email, password, role, totpSecret };
}

/** A session issued the way login issues one, as a Cookie header value. */
export async function sessionCookieFor(app: INestApplication, userId: string): Promise<string> {
  const { token } = await app.get(SessionsService).create(userId);
  return `hotel_session=${token}`;
}

/** The hotel_session cookie a response set, as a Cookie header value, or null. */
export function cookieFrom(res: Response): string | null {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const line = (raw ?? []).find((c) => c.startsWith('hotel_session='));
  if (!line) return null;
  const value = line.split(';')[0];
  return value === 'hotel_session=' ? null : value;
}

/** The full Set-Cookie line for hotel_session (attribute checks). */
export function setCookieLine(res: Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? []).find((c) => c.startsWith('hotel_session='));
}
