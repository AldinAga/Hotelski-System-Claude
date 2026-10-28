#!/usr/bin/env node
// Phase 1a smoke test against a FRESH hotel-api (setup not done yet):
// activation -> owner (TOTP from totpUri) -> TOTP confirmation -> sign-in ->
// unit type with 2 units -> rate plan priced for 30 days -> reservation ->
// the calendar shows the stay -> cancellation -> the calendar no longer does.
//
//   node scripts/smoke-1a.mjs --api http://192.168.1.199:4200 \
//     --setup-token <from `docker logs hotel-api-claude`> --code <activation code> \
//     --email vlasnik@primer.rs [--password ...] [--totp-out ./owner-totp.txt]
//
// The owner's password comes from --password or HOTEL_SMOKE_PASSWORD (at least
// 10 characters). The TOTP URI is a secret: it is never printed; with
// --totp-out it is written to that file (mode 600) so the owner can add it to
// an authenticator app and sign in to the web later.
//
// Prints one "OK <step>" line per step; on the first failure prints
// "FAIL <step>: ..." and exits 1. Exit 0 only when every step passed.
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const api = (arg('api', '') ?? '').replace(/\/+$/, '');
const setupToken = arg('setup-token');
const code = arg('code');
const email = arg('email', 'vlasnik@hotel.test');
const password = arg('password', process.env.HOTEL_SMOKE_PASSWORD);
const propertyName = arg('property-name', 'Hotel Smoke');
const legalKind = arg('legal-kind', 'legal_entity');
const totpOut = arg('totp-out');
const timeZone = arg('time-zone', 'Europe/Belgrade');

function usage(problem) {
  console.error(`FAIL arguments: ${problem}`);
  console.error(
    'Usage: node scripts/smoke-1a.mjs --api <url> --setup-token <token> --code <activation code> ' +
      '[--email <email>] [--password <password> | HOTEL_SMOKE_PASSWORD] [--totp-out <file>]',
  );
  process.exit(1);
}
if (!api) usage('--api is required');
if (!setupToken) usage('--setup-token is required');
if (!code) usage('--code is required');
if (!password || password.length < 10) usage('--password or HOTEL_SMOKE_PASSWORD (at least 10 characters) is required');

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s), as the API and authenticator apps do.
function base32Decode(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of text.replace(/=+$/, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error('secret is not base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secret, date) {
  const step = Math.floor(date.getTime() / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// ---- Dates: the property's local calendar day, as the API counts nights.
function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---- HTTP
let cookie = '';
async function call(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    redirect: 'error',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

class StepFailure extends Error {}

function expectStatus(res, expected) {
  if (res.status !== expected) {
    const detail = res.body?.code ? `${res.body.code}: ${res.body.message ?? ''}` : res.text.slice(0, 300);
    throw new StepFailure(`HTTP ${res.status} (expected ${expected}) ${detail}`);
  }
  return res.body;
}

function check(condition, message) {
  if (!condition) throw new StepFailure(message);
}

async function step(name, fn) {
  try {
    const result = await fn();
    console.log(`OK   ${name}`);
    return result;
  } catch (err) {
    const why = err instanceof StepFailure ? err.message : `${err.name}: ${err.message}${err.cause ? ` (${err.cause.message ?? err.cause})` : ''}`;
    console.log(`FAIL ${name}: ${why}`);
    process.exit(1);
  }
}

// ---- The run
const start = today();
const arrival = addDays(start, 1);
const departure = addDays(start, 3);

await step('health', async () => {
  const body = expectStatus(await call('GET', '/health'), 200);
  check(body?.status === 'ok', 'health is not ok');
});

await step('activation with the code', async () => {
  expectStatus(await call('POST', '/setup/activate', { setupToken, code }), 200);
});

const secret = await step('owner created (TOTP from totpUri)', async () => {
  const body = expectStatus(
    await call('POST', '/setup/owner', { setupToken, propertyName, legalKind, email, name: 'Vlasnik', password }),
    201,
  );
  check(typeof body?.totpUri === 'string', 'no totpUri in the answer');
  const s = new URL(body.totpUri).searchParams.get('secret');
  check(s && /^[A-Z2-7]+$/.test(s), 'totpUri has no base32 secret');
  if (totpOut) writeFileSync(totpOut, `${body.totpUri}\n`, { mode: 0o600 });
  return s;
});

await step('TOTP confirmed, setup closed', async () => {
  expectStatus(await call('POST', '/setup/confirm', { setupToken, totp: totpAt(secret, new Date()) }), 200);
});

await step('owner signs in with password and TOTP', async () => {
  // The confirmation used the current 30 s step; a code may be used once, so
  // sign in with the next step's code (the API accepts one step of drift).
  const res = await call('POST', '/auth/login', { email, password, totp: totpAt(secret, new Date(Date.now() + 30_000)) });
  expectStatus(res, 200);
  const session = res.headers.getSetCookie().find((c) => c.startsWith('hotel_session='));
  check(session, 'no hotel_session cookie');
  cookie = session.split(';')[0];
  const me = expectStatus(await call('GET', '/auth/me'), 200);
  check(me?.role === 'owner', `signed in as ${me?.role}, expected owner`);
});

const unitTypeId = await step('unit type with 2 units', async () => {
  const type = expectStatus(await call('POST', '/unit-types', { code: 'SMOKE', name: { sr: 'Dvokrevetna (smoke)' }, capacity: 2 }), 201);
  for (const name of ['S-1', 'S-2']) {
    expectStatus(await call('POST', '/units', { name, unitTypeId: type.id }), 201);
  }
  const units = expectStatus(await call('GET', '/units'), 200);
  check(units.filter((u) => u.unitTypeId === type.id).length === 2, 'the type does not have 2 units');
  return type.id;
});

const ratePlanId = await step('rate plan priced for 30 days', async () => {
  const plan = expectStatus(await call('POST', '/rate-plans', { code: 'BAR', name: { sr: 'Osnovna cena' } }), 201);
  const set = expectStatus(
    await call('PUT', `/rate-plans/${plan.id}/days`, {
      scope: { kind: 'unit_type', id: unitTypeId },
      from: start,
      to: addDays(start, 30),
      priceMinor: 500_000,
    }),
    200,
  );
  check(set?.days === 30, `priced ${set?.days} days, expected 30`);
  return plan.id;
});

const reservation = await step(`reservation ${arrival} - ${departure}`, async () => {
  const body = expectStatus(
    await call('POST', '/reservations', {
      source: 'front_desk',
      holder: { firstName: 'Smoke', lastName: 'Test' },
      stays: [{ unitTypeId, arrival, departure, adults: 2, ratePlanId }],
    }),
    201,
  );
  check(typeof body?.reservationId === 'string', 'no reservationId');
  return body;
});

function calendarHas(view, reservationId) {
  const inUnassigned = view.unassigned.some((s) => s.reservationId === reservationId);
  const inBars = view.units.some((u) => u.bars.some((b) => b.kind === 'stay' && b.reservationId === reservationId));
  return inUnassigned || inBars;
}

await step('calendar shows the stay', async () => {
  const view = expectStatus(await call('GET', `/calendar?from=${start}&to=${addDays(start, 30)}`), 200);
  check(calendarHas(view, reservation.reservationId), `reservation ${reservation.number} is not on the calendar`);
});

await step('cancellation', async () => {
  const current = expectStatus(await call('GET', `/reservations/${reservation.reservationId}`), 200);
  const body = expectStatus(
    await call('POST', `/reservations/${reservation.reservationId}/cancel`, { version: current.version }),
    200,
  );
  check(body?.status === 'cancelled', `status ${body?.status}`);
  const view = expectStatus(await call('GET', `/calendar?from=${start}&to=${addDays(start, 30)}`), 200);
  check(!calendarHas(view, reservation.reservationId), 'the cancelled stay is still on the calendar');
});

console.log('OK   smoke 1a passed');
