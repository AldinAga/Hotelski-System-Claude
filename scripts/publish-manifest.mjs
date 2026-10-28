#!/usr/bin/env node
// Publishes product/manifest.json to the Central Admin Panel:
//   POST {CENTRAL_ADMIN_URL}/v1/products/hotel/manifests
//   Authorization: Bearer {HOTEL_PUBLISHER_TOKEN}   (a product_publisher service token)
//
//   CENTRAL_ADMIN_URL=http://192.168.1.199:4100 HOTEL_PUBLISHER_TOKEN=... node scripts/publish-manifest.mjs
//   node scripts/publish-manifest.mjs --manifest path/to/manifest.json
//
// Exit 0: published, or this exact version was already published.
// Exit 1: missing configuration, the Admin Panel refused the manifest (its
// problems are printed one per line), or the Admin Panel was unreachable.
// The token is never printed; redirects are refused so it cannot be sent to
// another location.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message) {
  console.error(`Neuspešno: ${message}`);
  process.exit(1);
}

const baseUrl = (process.env.CENTRAL_ADMIN_URL ?? '').trim().replace(/\/+$/, '');
const token = (process.env.HOTEL_PUBLISHER_TOKEN ?? '').trim();
if (!baseUrl) fail('CENTRAL_ADMIN_URL nije postavljen.');
if (!token) fail('HOTEL_PUBLISHER_TOKEN nije postavljen (servisni token product_publisher iz Admin Panela).');

const manifestPath = resolve(argValue('--manifest') ?? resolve(here, '../product/manifest.json'));
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  fail(`manifest ${manifestPath} nije čitljiv JSON (${err.message}).`);
}

const scrub = (text) => String(text).split(token).join('***');

let res;
try {
  res = await fetch(`${baseUrl}/v1/products/hotel/manifests`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(manifest),
    signal: AbortSignal.timeout(30_000),
  });
} catch (err) {
  fail(`Admin Panel nije dostupan na ${baseUrl} (${scrub(err.cause?.message ?? err.message)}).`);
}

const text = await res.text();
let body = {};
try {
  body = text ? JSON.parse(text) : {};
} catch {
  body = { message: text.slice(0, 500) };
}

if (res.ok) {
  console.log(`Objavljen manifest hotel ${body.version ?? manifest.version}: ${body.moduleCount ?? '?'} modula, ${body.limitTypeCount ?? '?'} tipova limita.`);
  for (const key of body.deprecatedModules ?? []) console.log(`  zastareo modul: ${key}`);
  for (const key of body.deprecatedLimitTypes ?? []) console.log(`  zastareo tip limita: ${key}`);
  process.exit(0);
}

if (res.status === 409 && body.code === 'manifest_version_exists') {
  console.log(`Manifest verzije ${manifest.version} je već objavljen; ništa nije promenjeno.`);
  process.exit(0);
}

console.error(`Admin Panel je odbio manifest (HTTP ${res.status}${body.code ? `, ${body.code}` : ''}).`);
if (Array.isArray(body.problems) && body.problems.length > 0) {
  for (const p of body.problems) console.error(`  - ${scrub(p)}`);
} else if (body.message) {
  // The Admin Panel answers { code, message }; manifest_invalid joins its
  // problems into the message after "Manifest nije ispravan:".
  const message = scrub(body.message);
  const [head, rest] = message.split(/:\s(.+)/s);
  if (body.code === 'manifest_invalid' && rest) {
    console.error(`  ${head}:`);
    for (const p of rest.split(/(?<=\.)\s+(?=\S)/)) console.error(`  - ${p}`);
  } else {
    console.error(`  ${message}`);
  }
}
process.exit(1);
