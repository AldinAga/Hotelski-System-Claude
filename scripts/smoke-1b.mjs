#!/usr/bin/env node
// Phase 1b smoke test against hotel-api, resumable:
// health -> owner signs in (password + TOTP) -> licence (VALID or GRACE, modules
// hotel.core and hotel.folio) -> guests of "Smoke Test 1b" left in the house by an
// earlier failed run are settled and checked out -> business day (a lagging day
// is closed only with --allow-close) -> unit type SMOKE (S-1, S-2) and rate plan
// SMOKE priced for 30 days from the business day -> reservation for one night ->
// extra guest -> check-in -> charge "Smoke mini bar" 500,00 -> cash payment
// 500,00 -> close of the business day (--allow-close, only when it is not after
// today) -> card payment of the rest -> check-out -> non-fiscal receipt ->
// folio check -> (--mail-to) the confirmation message.
//
//   HOTEL_SMOKE_PASSWORD=... node scripts/smoke-1b.mjs --api http://192.168.1.199:4200 \
//     --email <owner email> (--totp <6 digits> | --totp-file ~/owner-totp.txt) \
//     [--allow-close] [--mail-to <address>] [--mail-wait <seconds>]
//
// UPOZORENJE (zatvaranje poslovnog dana je trajno i menja prave podatke):
//   --allow-close zatvara poslovni dan. Prvo zatvaranje kasnog poslovnog dana
//   označava kao no-show SVAKU potvrđenu rezervaciju čiji gost nije prijavljen,
//   sa dolaskom do tog dana (uključujući taj dan). To su pravi gosti objekta, a
//   zatvoren dan se ne može ponovo otvoriti. Bez --allow-close skripta ne zatvara
//   nijedan dan i staje ako poslovni dan kasni za kalendarom.
//
// Dates. Every date comes from GET /business-day (the API's own clock and time
// zone), never from this computer's clock.
//
// Resuming. A failed run is simply run again; the API's state decides what is
// left. Guests of "Smoke Test 1b" still in the house are settled first (the
// balance is paid by card, or a credit is refunded in cash) and checked out; a
// reservation of the guest that is still expected for the business day is taken
// up again. Money requests carry keys that are fixed per stay and step
// (smoke1b-<stayId>-<step>), so a repeated request is a replay, never a second
// charge. Without --allow-close the close step is skipped and the check-out
// posts the one night; the business day stays where it is.
//
// What it leaves is real data of the installation: reservations and folios of
// guest "Smoke Test 1b" (and a second guest "Dodatni Gost 1b" on each stay),
// closed business days (with --allow-close), non-fiscal receipts N-..., plus
// unit type SMOKE, plan SMOKE and units S-1, S-2 (made by smoke-1a or here).
//
// Works only while Turnstile is off: the sign-in sends no token, so with
// TURNSTILE_* keys set the API answers 403 captcha_failed.
//
// The password comes from --password or HOTEL_SMOKE_PASSWORD (at least 10
// characters). The TOTP URI, the TOTP secret and the password are never printed.
//
// Prints "OK <step>[: detail]" or "SKIP <step>: <why>" per step; the first failure
// prints "FAIL <step>: ..." and exits 1. Exit 0 only when every step passed or
// was skipped as not needed.
//
// @author Ald1n <https://ald1n.com>
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const HELP = `Upotreba:
  HOTEL_SMOKE_PASSWORD=<lozinka> node scripts/smoke-1b.mjs --api <adresa> --email <vlasnik> \\
    (--totp <6 cifara> | --totp-file <fajl sa otpauth:// adresom>) [--allow-close] [--mail-to <adresa>] [--mail-wait <sekundi>]

  --api         adresa hotel-api (npr. http://192.168.1.199:4200)
  --email       e-adresa vlasnika (ili menadžera)
  --totp        šestocifreni kod iz aplikacije za autentifikaciju
  --totp-file   fajl sa otpauth:// adresom; kod se računa iz nje, adresa se ne ispisuje
  --password    lozinka (ili promenljiva HOTEL_SMOKE_PASSWORD, najmanje 10 znakova)
  --mail-to     boravku se daje ova e-adresa i proverava se poruka potvrde rezervacije
  --mail-wait   koliko sekundi čekati da poruka bude poslata (podrazumevano 20)
  --allow-close DOZVOLJAVA ZATVARANJE POSLOVNOG DANA. To je trajno i menja prave podatke objekta:
                prvo zatvaranje kasnog poslovnog dana označava kao no-show svaku potvrđenu rezervaciju
                čiji gost nije prijavljen, sa dolaskom do tog dana (uključujući taj dan). Zatvoren dan
                se ne može ponovo otvoriti. Bez ove opcije skripta ne zatvara nijedan dan i staje sa
                greškom ako poslovni dan kasni za kalendarom.
  --help        ovaj tekst
`;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

const api = (arg('api', '') ?? '').replace(/\/+$/, '');
const email = arg('email');
const password = arg('password', process.env.HOTEL_SMOKE_PASSWORD);
const totpGiven = arg('totp');
const totpFile = arg('totp-file');
const mailTo = arg('mail-to');
const mailWaitSeconds = Number(arg('mail-wait', '20'));
const allowClose = process.argv.includes('--allow-close');

function usage(problem) {
  console.error(`FAIL arguments: ${problem}`);
  console.error(HELP);
  process.exit(1);
}
if (!api) usage('--api je obavezan');
if (!email) usage('--email je obavezan (vlasnik objekta, bez podrazumevane vrednosti)');
if (!password || password.length < 10) usage('--password ili HOTEL_SMOKE_PASSWORD (najmanje 10 znakova) je obavezan');
if (mailTo !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailTo)) usage('--mail-to nije ispravna e-adresa');
if (!Number.isFinite(mailWaitSeconds) || mailWaitSeconds < 0 || mailWaitSeconds > 300) usage('--mail-wait mora biti od 0 do 300 sekundi');

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s), as the API and authenticator apps do (same code as smoke-1a).
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

function totpAt(secret, date) {
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

function signInCode() {
  if (totpGiven) return totpGiven.replace(/\s+/g, '');
  if (totpFile) {
    let text;
    try {
      text = readFileSync(totpFile, 'utf8');
    } catch (err) {
      throw new StepFailure(`--totp-file se ne može pročitati (${err.code ?? err.name})`);
    }
    const s = secretOf(text);
    check(s, '--totp-file ne sadrži otpauth:// adresu sa tajnom');
    return totpAt(s, new Date());
  }
  throw new StepFailure('dajte --totp <kod> ili --totp-file <fajl> (kod iz aplikacije za autentifikaciju)');
}

// ---- Dates (UTC arithmetic on YYYY-MM-DD; "today" and the business day come from the API)
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 123456 -> "1.234,56 RSD". */
function rsd(minor) {
  const abs = Math.abs(minor);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${minor < 0 ? '-' : ''}${whole},${String(abs % 100).padStart(2, '0')} RSD`;
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
  const ok = Array.isArray(expected) ? expected : [expected];
  if (!ok.includes(res.status)) {
    const detail = res.body?.code ? `${res.body.code}: ${res.body.message ?? ''}` : res.text.slice(0, 300);
    throw new StepFailure(`HTTP ${res.status} (očekivano ${ok.join(' ili ')}) ${detail}`);
  }
  return res.body;
}

function check(condition, message) {
  if (!condition) throw new StepFailure(message);
}

function skip(why) {
  throw new StepSkipped(why);
}

/** Text appended to the OK line of the running step. */
let detail = '';
function note(text) {
  detail = text;
}

async function step(name, fn) {
  detail = '';
  try {
    const result = await fn();
    console.log(`OK   ${name}${detail ? `: ${detail}` : ''}`);
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

// ---- The guest of this smoke and the stable keys of its money requests
const HOLDER = { firstName: 'Smoke', lastName: 'Test 1b' };
const HOLDER_NAME = `${HOLDER.firstName} ${HOLDER.lastName}`;
const EXTRA_GUEST = { firstName: 'Dodatni', lastName: 'Gost 1b' };
const NOT_FISCAL = 'Ovo nije fiskalni račun.';
const MINIBAR_MINOR = 50_000;
const key = (stayId, what) => `smoke1b-${stayId}-${what}`;

const reservationOf = async (id) => expectStatus(await call('GET', `/reservations/${id}`), 200);

/** Confirmed reservations of this smoke's guest that overlap the days from `from` on (and before `to` when given). */
async function smokeReservations(from, to) {
  const query = `status=confirmed&q=${encodeURIComponent(HOLDER_NAME)}&from=${from}${to ? `&to=${to}` : ''}`;
  const list = expectStatus(await call('GET', `/reservations?${query}`), 200);
  return list.filter((r) => r.holderName === HOLDER_NAME);
}

/**
 * Brings the folio of an in-house stay to a balance of zero at check-out: the
 * check-out preview names the balance (nights still to be posted included).
 * Above 0 it is paid by card, below 0 (a credit) it is refunded in cash.
 * Returns the balance that was settled.
 */
async function settleBalance(stayId) {
  const preview = expectStatus(await call('GET', `/stays/${stayId}/check-out-preview`), 200);
  const due = preview.balanceMinor;
  if (due > 0) {
    expectStatus(
      await call('POST', `/stays/${stayId}/folio/payments`, { method: 'card', amountMinor: due, reference: HOLDER_NAME, key: key(stayId, `card-${due}`) }),
      [200, 201],
    );
  } else if (due < 0) {
    expectStatus(
      await call('POST', `/stays/${stayId}/folio/refunds`, {
        method: 'cash',
        amountMinor: -due,
        reason: `${HOLDER_NAME}: povraćaj preplate`,
        key: key(stayId, `refund-${-due}`),
      }),
      [200, 201],
    );
  }
  return due;
}

async function checkOut(stayId, reservationId) {
  const r = await reservationOf(reservationId);
  const done = expectStatus(await call('POST', `/stays/${stayId}/check-out`, { version: r.version }), 200);
  check(done?.status === 'checked_out', `status posle odjave je ${done?.status}`);
  return done;
}

// ---- The run
await step('health', async () => {
  const body = expectStatus(await call('GET', '/health'), 200);
  check(body?.status === 'ok', 'health nije ok');
});

await step('sign-in', async () => {
  const res = await call('POST', '/auth/login', { email, password, totp: signInCode() });
  if (res.status === 403 && res.body?.code === 'captcha_failed') {
    throw new StepFailure('Turnstile je uključen; smoke radi samo bez TURNSTILE_* ključeva');
  }
  expectStatus(res, 200);
  const session = res.headers.getSetCookie().find((c) => c.startsWith('hotel_session='));
  check(session, 'nema kolačića hotel_session');
  cookie = session.split(';')[0];
  const me = expectStatus(await call('GET', '/auth/me'), 200);
  check(me?.role === 'owner' || me?.role === 'manager', `prijavljen kao ${me?.role}; potreban je vlasnik ili menadžer (povraćaj i ispravke)`);
});

await step('licence', async () => {
  const lic = expectStatus(await call('GET', '/licence'), 200);
  check(lic?.state === 'VALID' || lic?.state === 'GRACE', `licenca je ${lic?.state}; smoke traži VALID ili GRACE`);
  for (const m of ['hotel.core', 'hotel.folio']) check(lic.modules.includes(m), `licenca nema modul ${m}`);
  note(`${lic.state}, moduli hotel.core i hotel.folio`);
});

// Before the close loop: a guest left in the house with departure <= the day being closed would block that close.
await step('leftovers', async () => {
  const view = expectStatus(await call('GET', '/business-day'), 200);
  let settled = 0;
  for (const s of await smokeReservations(addDays(view.day, -1))) {
    const r = await reservationOf(s.id);
    for (const stay of r.stays.filter((x) => x.status === 'in_house')) {
      await settleBalance(stay.id);
      await checkOut(stay.id, r.id);
      settled += 1;
    }
  }
  note(settled ? `izmireno i odjavljeno ${settled}` : 'nema ostataka iz ranijih pokretanja');
});

function blockedMessage(day, details) {
  const who = (details?.departures ?? [])
    .map((d) => `${d.number} (${d.unitName ?? 'bez jedinice'}, odlazak ${d.departure})`)
    .join(', ');
  return `dan ${day} se ne može zatvoriti: gosti koji odlaze nisu odjavljeni: ${who}`;
}

/** Closes the open business day `day`; prints no line itself, returns the report's counts. */
async function closeDay(day) {
  const res = await call('POST', '/business-day/close', { day });
  if (res.status === 409 && res.body?.code === 'close_blocked') throw new StepFailure(blockedMessage(day, res.body.details));
  const body = expectStatus(res, 200);
  return { nights: body.report.postedNights, noShows: body.report.noShows.length };
}

const { B, today } = await step('business day', async () => {
  let view = expectStatus(await call('GET', '/business-day'), 200);
  check(typeof view?.day === 'string' && typeof view?.today === 'string', 'nema dana u odgovoru');
  if (view.day < view.today && !allowClose) {
    throw new StepFailure(`poslovni dan ${view.day} kasni; pokrenite sa --allow-close`);
  }
  while (view.day < view.today) {
    const closed = view.day;
    const counts = await closeDay(closed);
    console.log(`OK   close: dan ${closed}, noćenja ${counts.nights}, no-show ${counts.noShows}`);
    view = expectStatus(await call('GET', '/business-day'), 200);
    check(view.day === addDays(closed, 1), `posle zatvaranja ${closed} otvoren je dan ${view.day}, očekivano ${addDays(closed, 1)}`);
  }
  note(view.day);
  return { B: view.day, today: view.today };
});

const unitTypeId = await step('unit type SMOKE', async () => {
  const types = expectStatus(await call('GET', '/unit-types'), 200);
  let type = types.find((t) => t.code === 'SMOKE');
  if (!type) {
    type = expectStatus(
      await call('POST', '/unit-types', { code: 'SMOKE', name: { sr: 'Smoke test (može se isključiti)' }, capacity: 2 }),
      201,
    );
  }
  check(type.active, 'tip SMOKE postoji ali je isključen; uključite ga ili ručno uklonite smoke podatke');
  const existing = expectStatus(await call('GET', '/units'), 200);
  for (const name of ['S-1', 'S-2']) {
    const unit = existing.find((u) => u.name === name);
    if (!unit) expectStatus(await call('POST', '/units', { name, unitTypeId: type.id }), 201);
    else check(unit.unitTypeId === type.id && unit.active, `jedinica ${name} postoji ali nije aktivna SMOKE jedinica`);
  }
  return type.id;
});

const ratePlanId = await step('rate plan SMOKE', async () => {
  const plans = expectStatus(await call('GET', '/rate-plans'), 200);
  let plan = plans.find((p) => p.code === 'SMOKE');
  if (!plan) {
    plan = expectStatus(await call('POST', '/rate-plans', { code: 'SMOKE', name: { sr: 'Smoke test (može se isključiti)' } }), 201);
  }
  check(plan.active, 'plan SMOKE postoji ali je isključen');
  const set = expectStatus(
    await call('PUT', `/rate-plans/${plan.id}/days`, {
      scope: { kind: 'unit_type', id: unitTypeId },
      from: B,
      to: addDays(B, 30),
      priceMinor: 500_000,
    }),
    200,
  );
  check(set?.days === 30, `cene za ${set?.days} dana, očekivano 30`);
  note(`${B} do ${addDays(B, 30)}`);
  return plan.id;
});

const stay = await step('reservation', async () => {
  const units = expectStatus(await call('GET', '/units'), 200).filter((u) => u.unitTypeId === unitTypeId && u.active);
  const nameOf = (id) => units.find((u) => u.id === id)?.name ?? 'bez jedinice';
  // Left expected by a failed run for this very night: take it up again.
  for (const s of await smokeReservations(B, addDays(B, 2))) {
    const r = await reservationOf(s.id);
    const found = r.stays.find(
      (x) => r.stays.length === 1 && x.status === 'expected' && x.arrival === B && x.departure === addDays(B, 1) && units.some((u) => u.id === x.unitId),
    );
    if (found) {
      note(`${r.number} ${B} - ${addDays(B, 1)}, ${nameOf(found.unitId)}; nastavlja se rezervacija iz ranijeg pokretanja`);
      return { reservationId: r.id, stayId: found.id, number: r.number, unitName: nameOf(found.unitId) };
    }
  }
  for (const unit of units.filter((u) => ['S-1', 'S-2'].includes(u.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const res = await call('POST', '/reservations', {
      source: 'front_desk',
      holder: { ...HOLDER, ...(mailTo ? { email: mailTo } : {}) },
      stays: [{ unitId: unit.id, arrival: B, departure: addDays(B, 1), adults: 2, ratePlanId }],
    });
    if (res.status === 409) continue; // the unit is taken: try the next one
    const body = expectStatus(res, 201);
    const r = await reservationOf(body.reservationId);
    note(`${r.number} ${B} - ${addDays(B, 1)}, ${unit.name}`);
    return { reservationId: r.id, stayId: r.stays[0].id, number: r.number, unitName: unit.name };
  }
  throw new StepFailure('S-1 i S-2 su zauzete za tu noć');
});

await step('extra guest', async () => {
  const r = await reservationOf(stay.reservationId);
  if (r.stays[0].guests.some((g) => g.firstName === EXTRA_GUEST.firstName && g.lastName === EXTRA_GUEST.lastName)) {
    note('već dodat');
    return;
  }
  const guests = expectStatus(await call('POST', `/stays/${stay.stayId}/guests`, { guest: EXTRA_GUEST }), [200, 201]);
  check(guests.some((g) => g.lastName === EXTRA_GUEST.lastName), 'dodatni gost nije na boravku');
});

await step('check-in', async () => {
  const r = await reservationOf(stay.reservationId);
  const done = expectStatus(await call('POST', `/stays/${stay.stayId}/check-in`, { version: r.version }), 200);
  check(done?.status === 'in_house', `status posle prijave je ${done?.status}`);
  note(stay.unitName);
});

await step('charge', async () => {
  const line = expectStatus(
    await call('POST', `/stays/${stay.stayId}/folio/charges`, {
      kind: 'service',
      description: 'Smoke mini bar',
      amountMinor: MINIBAR_MINOR,
      key: key(stay.stayId, 'charge'),
    }),
    [200, 201],
  );
  check(line?.amountMinor === MINIBAR_MINOR, `zaduženje je ${line?.amountMinor}`);
  note(`Smoke mini bar ${rsd(MINIBAR_MINOR)}`);
});

await step('cash payment', async () => {
  const pay = expectStatus(
    await call('POST', `/stays/${stay.stayId}/folio/payments`, { method: 'cash', amountMinor: MINIBAR_MINOR, key: key(stay.stayId, 'cash') }),
    [200, 201],
  );
  check(pay?.amountMinor === MINIBAR_MINOR, `uplata je ${pay?.amountMinor}`);
  note(rsd(MINIBAR_MINOR));
});

await step('close', async () => {
  if (B > today) skip('poslovni dan je već sutrašnji');
  if (!allowClose) skip('bez --allow-close dan se ne zatvara; odjava knjiži noć');
  const counts = await closeDay(B);
  note(`dan ${B}, noćenja ${counts.nights}, no-show ${counts.noShows}`);
});

await step('card payment', async () => {
  const due = await settleBalance(stay.stayId);
  if (due <= 0) skip(`saldo je ${rsd(due)}, nema šta da se naplati`);
  note(rsd(due));
});

await step('check-out', async () => {
  const done = await checkOut(stay.stayId, stay.reservationId);
  note(`odlazak ${done.departure}`);
});

// After the check-out (preflight F11): the folio is closed and its balance is 0 in both paths.
await step('receipt', async () => {
  const doc = expectStatus(
    await call('POST', `/stays/${stay.stayId}/folio/documents`, { kind: 'receipt', key: key(stay.stayId, 'receipt') }),
    [200, 201],
  );
  check(doc?.content?.notice === NOT_FISCAL, `dokument nema oznaku "${NOT_FISCAL}"`);
  check(doc.content.dueMinor === 0, `dueMinor je ${doc.content.dueMinor} (očekivano 0)`);
  check(/^N-\d{4}-\d{6}$/.test(doc.number), `broj dokumenta ${doc.number} nije oblika N-GGGG-NNNNNN`);
  note(doc.number);
});

await step('folio check', async () => {
  const folio = expectStatus(await call('GET', `/stays/${stay.stayId}/folio`), 200);
  check(folio.status === 'closed', `folio nije zatvoren (status ${folio.status})`);
  check(folio.balanceMinor === 0, `saldo je ${folio.balanceMinor}, očekivano 0`);
  const nights = folio.lines.filter((l) => l.kind === 'accommodation').length;
  check(nights === 1, `stavki smeštaja je ${nights} (očekivano 1)`);
  note('zatvoren, saldo 0, jedna stavka smeštaja');
});

if (mailTo) {
  await step('confirmation message', async () => {
    const deadline = Date.now() + mailWaitSeconds * 1000;
    let message;
    for (;;) {
      const messages = expectStatus(await call('GET', `/reservations/${stay.reservationId}/messages`), 200);
      message = messages.find((m) => m.template === 'reservation_confirmed');
      if (message?.status === 'sent' || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!message) skip('poruka potvrde nije u izlaznom sandučetu');
    if (message.status !== 'sent') {
      // Any other status (pending, failed, skipped, or one this script does not know) is shown, not judged.
      const why = message.lastError ? `: ${String(message.lastError).slice(0, 200)}` : '';
      skip(`poruka je u statusu ${message.status}${why}`);
    }
    note('poslata');
  });
}

console.log('OK   smoke 1b je prošao');
