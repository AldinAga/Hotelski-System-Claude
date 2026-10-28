#!/usr/bin/env node
// Phase 1a smoke test against hotel-api, resumable:
// setup status -> activation -> owner (TOTP from totpUri) -> TOTP confirmation
// -> sign-in -> unit type SMOKE with 2 units -> rate plan SMOKE priced for 30
// days -> reservation -> the calendar shows the stay -> cancellation -> the
// calendar no longer does.
//
//   node scripts/smoke-1a.mjs --api http://192.168.1.199:4200 \
//     --email <real owner email> --property-name "<real property name>" \
//     --setup-token <from `docker logs hotel-api-claude`> --code <activation code> \
//     [--password ...] [--totp-out ./owner-totp.txt]
//
// Resuming. The activation code is single-use and the databases are never
// recreated, so a failed run is simply run again: GET /setup/status decides
// what is left.
//  - Activation already done: skipped (SKIP line), --code is not needed.
//  - Owner entered but not confirmed: the owner step runs again (a new TOTP
//    secret; the old QR code stops working).
//  - Setup done (410): the setup steps are skipped and the owner signs in with
//    --password and a TOTP code: --totp <6 digits> from the authenticator app,
//    or --totp-file <file> holding the otpauth:// URI an earlier --totp-out wrote.
//  - The unit type SMOKE (units S-1, S-2) and the rate plan SMOKE are reused
//    when they exist. Each run adds one reservation and cancels it.
//
// What it leaves is real data of the installation: the property name and the
// owner are the ones given here (there is no default; the API cannot rename the
// property later), plus type SMOKE, plan SMOKE and cancelled reservations of
// guest "Smoke Test", which the owner can switch off in Podešavanja.
//
// The owner's password comes from --password or HOTEL_SMOKE_PASSWORD (at least
// 10 characters). The TOTP URI is a secret: it is never printed; with
// --totp-out it is written to that file (mode 600) so the owner can add it to
// an authenticator app and sign in to the web later.
//
// Prints one "OK <step>" or "SKIP <step>: <why>" line per step; on the first
// failure prints "FAIL <step>: ..." and exits 1. Exit 0 only when every step
// passed or was skipped as already done.
import { createHmac } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const api = (arg('api', '') ?? '').replace(/\/+$/, '');
const setupToken = arg('setup-token');
const code = arg('code');
const email = arg('email');
const password = arg('password', process.env.HOTEL_SMOKE_PASSWORD);
const propertyName = arg('property-name');
const legalKind = arg('legal-kind', 'legal_entity');
const ownerName = arg('owner-name', 'Vlasnik');
const totpOut = arg('totp-out');
const totpGiven = arg('totp');
const totpFile = arg('totp-file');
const timeZone = arg('time-zone', 'Europe/Belgrade');

function usage(problem) {
  console.error(`FAIL arguments: ${problem}`);
  console.error(
    'Usage: node scripts/smoke-1a.mjs --api <url> --email <owner email> --property-name <name> ' +
      '[--setup-token <token>] [--code <activation code>] [--password <password> | HOTEL_SMOKE_PASSWORD] ' +
      '[--totp-out <file>] [--totp <code> | --totp-file <file>]',
  );
  process.exit(1);
}
if (!api) usage('--api is required');
if (!email) usage('--email is required (the real owner; there is no default)');
if (!propertyName) usage('--property-name is required (the real property; there is no default)');
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

/** The base32 secret of an otpauth:// URI, or null. Never printed. */
function secretOf(uri) {
  try {
    const s = new URL(uri.trim()).searchParams.get('secret');
    return s && /^[A-Z2-7]+=*$/i.test(s) ? s.toUpperCase() : null;
  } catch {
    return null;
  }
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
/** Thrown by a step that has nothing to do; its message says why. */
class StepSkipped extends Error {}

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

function skip(why) {
  throw new StepSkipped(why);
}

async function step(name, fn) {
  try {
    const result = await fn();
    console.log(`OK   ${name}`);
    return result;
  } catch (err) {
    if (err instanceof StepSkipped) {
      console.log(`SKIP ${name}: ${err.message}`);
      return undefined;
    }
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

/** null once setup is done (410), else {activated, hasOwner, hasProperty}. */
const setup = await step('setup status', async () => {
  const res = await call('GET', '/setup/status');
  if (res.status === 410) return null;
  const body = expectStatus(res, 200);
  check(typeof body?.activated === 'boolean', 'no "activated" in the answer');
  check(setupToken, 'setup is open; --setup-token is required (docker logs hotel-api-claude)');
  return body;
});

await step('activation with the code', async () => {
  if (setup === null) skip('setup is done');
  if (setup.activated) skip('already activated');
  check(code, 'not activated yet; --code <activation code> is required');
  expectStatus(await call('POST', '/setup/activate', { setupToken, code }), 200);
});

const secret = await step('owner created (TOTP from totpUri)', async () => {
  if (setup === null) skip('setup is done');
  // Also when the owner exists but is not confirmed: repeating replaces the secret.
  const body = expectStatus(
    await call('POST', '/setup/owner', { setupToken, propertyName, legalKind, email, name: ownerName, password }),
    201,
  );
  check(typeof body?.totpUri === 'string', 'no totpUri in the answer');
  const s = secretOf(body.totpUri);
  check(s, 'totpUri has no base32 secret');
  if (totpOut) {
    // `mode` applies only when the file is created; chmod also narrows an existing file.
    writeFileSync(totpOut, `${body.totpUri}\n`, { mode: 0o600 });
    chmodSync(totpOut, 0o600);
  }
  return s;
});

await step('TOTP confirmed, setup closed', async () => {
  if (setup === null) skip('setup is done');
  expectStatus(await call('POST', '/setup/confirm', { setupToken, totp: totpAt(secret, new Date()) }), 200);
});

/** The code to sign in with: after a fresh confirmation the next step's, else what was given. */
function signInCode() {
  // The confirmation used the current 30 s step; a code may be used once, so
  // sign in with the next step's code (the API accepts one step of drift).
  if (secret) return totpAt(secret, new Date(Date.now() + 30_000));
  if (totpGiven) return totpGiven.replace(/\s+/g, '');
  if (totpFile) {
    let text;
    try {
      text = readFileSync(totpFile, 'utf8');
    } catch (err) {
      throw new StepFailure(`cannot read --totp-file (${err.code ?? err.name})`);
    }
    const s = secretOf(text);
    check(s, '--totp-file does not hold an otpauth:// URI with a secret');
    return totpAt(s, new Date());
  }
  throw new StepFailure('setup is done; give --totp <code> or --totp-file <file> to sign in as the owner');
}

await step('owner signs in with password and TOTP', async () => {
  const res = await call('POST', '/auth/login', { email, password, totp: signInCode() });
  expectStatus(res, 200);
  const session = res.headers.getSetCookie().find((c) => c.startsWith('hotel_session='));
  check(session, 'no hotel_session cookie');
  cookie = session.split(';')[0];
  const me = expectStatus(await call('GET', '/auth/me'), 200);
  check(me?.role === 'owner', `signed in as ${me?.role}, expected owner`);
});

const unitTypeId = await step('unit type SMOKE with 2 units', async () => {
  const types = expectStatus(await call('GET', '/unit-types'), 200);
  let type = types.find((t) => t.code === 'SMOKE');
  if (!type) {
    type = expectStatus(
      await call('POST', '/unit-types', { code: 'SMOKE', name: { sr: 'Smoke test (može se isključiti)' }, capacity: 2 }),
      201,
    );
  }
  check(type.active, 'type SMOKE exists but is switched off; switch it on or remove the smoke data by hand');
  const existing = expectStatus(await call('GET', '/units'), 200);
  for (const name of ['S-1', 'S-2']) {
    const unit = existing.find((u) => u.name === name);
    if (!unit) expectStatus(await call('POST', '/units', { name, unitTypeId: type.id }), 201);
    else check(unit.unitTypeId === type.id && unit.active, `unit ${name} exists but is not an active SMOKE unit`);
  }
  const units = expectStatus(await call('GET', '/units'), 200);
  check(units.filter((u) => u.unitTypeId === type.id && u.active).length === 2, 'the type does not have 2 active units');
  return type.id;
});

const ratePlanId = await step('rate plan SMOKE priced for 30 days', async () => {
  const plans = expectStatus(await call('GET', '/rate-plans'), 200);
  let plan = plans.find((p) => p.code === 'SMOKE');
  if (!plan) {
    plan = expectStatus(await call('POST', '/rate-plans', { code: 'SMOKE', name: { sr: 'Smoke test (može se isključiti)' } }), 201);
  }
  check(plan.active, 'rate plan SMOKE exists but is switched off');
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
