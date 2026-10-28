# Faza 1a: temelj hotelskog sistema — implementacioni plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instalacija hotela koja se aktivira kodom iz Centralnog Admin Panela, ima korisnike sa ulogama, jedinice, osnovni cenovnik, rezervacije bez mogućnosti overbookinga i kalendar recepcije, i koja se testira i podiže na NAS-u.

**Architecture:** pnpm + Turbo monorepo sa `apps/hotel-api` (NestJS modularni monolit, Postgres preko Drizzle-a, ručne SQL migracije) i `apps/hotel-web` (Next.js, poziva API kroz `/api` proxy na istom originu). Licenca se proverava lokalno preko `@platform/licensing` po akciji; mreža prema Admin Panelu služi samo za aktivaciju, heartbeat i osvežavanje licence. Raspoloživost se čuva samo u `inventory_day` i menja se isključivo kroz jednu funkciju pod `SELECT … FOR UPDATE`; dodela jedinice je zaštićena exclusion constraint-om.

**Tech Stack:** Node 20, pnpm 9.6.0, Turbo, TypeScript ^5.5.3, NestJS ^10.4.0, drizzle-orm ^0.45.2, pg ^8.12.0, Jest ^29.7.0 (API), Next.js ^15.5.24 + React ^19 + Vitest (web), `@platform/licensing` 0.3.0, `@platform/money` 0.2.1 (Verdaccio `http://192.168.1.199:4873`).

**Spec:** `docs/specs/2026-10-10-hotel-system-design.md` (§3, §4.1, §4.3, §4.5, §5.1–5.4, §5.7, §9 bezbednost i siguran režim, §10). Granice repoa i NAS-a: `CLAUDE.md`.

**Obim 1a:** `hotel.core` bez check-in/check-out, gostiju za e-Turistu i email potvrda. Van obima (1b/1c i kasnije): folio, plaćanja, poslovni dan, noćni audit, pravni profil u punom obliku, e-Turista, fiskalizacija, check-in/out, `rates_advanced` (sezone, restrikcije, pansioni, izvedeni planovi), `fee`.

## Global Constraints

- Svaka poslovna tabela ima `property_id uuid NOT NULL REFERENCES property(id)`; svaki upit poslovne tabele filtrira po `property_id` (spec §5).
- Novac: celobrojne minor jedinice u koloni `bigint`, u kodu `Money` iz `@platform/money`; valuta `RSD` (spec §5, §5.1).
- Datumi boravka su lokalni `date` (`arrival`, `departure`), noć je `[arrival, departure)`; vremenska zona objekta podrazumevano `Europe/Belgrade`.
- Nijedan red u `inventory_day` se ne menja van `InventoryService` (spec §5.7: „jedini izvor raspoloživosti").
- Recepcija i svaki budući izvor (sajt, OTA) prave boravak kroz istu funkciju `ReservationsService.book` (spec §5.7).
- Isključenje modula nikad ne briše podatke (spec §4.5).
- Lista akcija dozvoljenih u sigurnom režimu je u kodu, `SAFE_MODE_ALLOWED` (spec §9).
- Obavezan TOTP za uloge `owner` i `manager` (spec §9).
- Audit svake promene: `audit_log` red u istoj transakciji kao promena (spec §9).
- Migracije su ručni `.sql` fajlovi bez `BEGIN/COMMIT` i bez `CREATE INDEX CONCURRENTLY`; migrator iz Admin Panela (`apps/admin-api/src/db/migrate.ts`) je obrazac.
- Testovi rade samo na NAS-u (`infrastructure/nas/ci.sh`); `pnpm install` na Windows-u se ne koristi. Lockfile se pravi na NAS-u.
- Na NAS-u postoje samo projekti `claude-hotel` i `claude-hotel-ci`; nijedan kontejner ne sme sam da se ugasi; jednokratni poslovi idu kroz `docker exec` (CLAUDE.md).
- Tekst za korisnika je na srpskom latinicom; kod, identifikatori i commit poruke na engleskom.
- Test koji tvrdi da guard, filter ili provera radi dokazuje se brisanjem te provere: test mora pasti (spec §10).

## Review Focus

1. **Dva paralelna bukinga poslednje slobodne jedinice tipa** → tačno jedan uspe, drugi dobija `409 no_availability`; `sold` nikad ne prelazi `total`. (Task 7)
2. **Deaktivacija jedinice ili blokada kad su noći već prodate** → odbija se sa `409 inventory_conflict` i datumom, umesto da `total` padne ispod `sold + blocked`. (Task 6, Task 7)
3. **Neispravni datumi boravka**: `departure <= arrival`, više od 365 noći, `arrival` u prošlosti za novu rezervaciju → `422` sa razlogom, ništa nije upisano. (Task 8)
4. **Cena nedostaje ili je dan zatvoren za neku noć** → rezervacija se ne pravi i greška imenuje prvi takav datum; nikad boravak sa cenom 0. (Task 8)
5. **Pristup posle isteka licence ili bez aktivacije** → nova rezervacija i izmena cena vraćaju `403 safe_mode_blocked` / `not_activated`, a pregled kalendara i rezervacija radi u sigurnom režimu. (Task 4)

---

## Struktura fajlova

```
package.json, pnpm-workspace.yaml, turbo.json, tsconfig.base.json, .npmrc
product/manifest.json                      manifest proizvoda hotel za Admin Panel
scripts/publish-manifest.mjs               objava manifesta servisnim tokenom
infrastructure/docker/docker-compose.yml   claude-hotel (postoji; dodaju se api i web)
infrastructure/docker/Dockerfile           slika hotel-api + hotel-web
infrastructure/nas/ci-compose.yml          claude-hotel-ci: runner + test baza
infrastructure/nas/ci.sh                   kod na NAS, install, testovi
infrastructure/nas/deploy.sh               ci.sh + slika + up claude-hotel
apps/hotel-api/
  src/main.ts, src/app.module.ts
  src/db/        pool.ts, migrate.ts, migrate-cli.ts, schema.ts, migrations/*.sql, database.module.ts
  src/common/    domain-error.ts, audit.service.ts, property-context.ts
  src/licensing/ central-admin.client.ts, licence.store.ts, licence.service.ts,
                 activation.service.ts, licensed-action.ts, licence.guard.ts, safe-mode.ts
  src/auth/      password.ts, totp.ts, sessions.service.ts, users.service.ts, auth.guard.ts,
                 auth.controller.ts, setup.service.ts, setup.controller.ts
  src/units/     units.service.ts, units.controller.ts
  src/inventory/ inventory.service.ts, unit-blocks.service.ts, unit-blocks.controller.ts
  src/rates/     rates.service.ts, quote.ts, rates.controller.ts
  src/reservations/ reservations.service.ts, reservations.controller.ts, stay-dates.ts
  src/calendar/  calendar.service.ts, calendar.controller.ts
  test/          db.ts, fake-central-admin.ts, app.ts (Nest test app), *.e2e-spec.ts
apps/hotel-web/
  next.config.ts (rewrite /api → HOTEL_API_URL), src/lib/api.ts
  src/app/aktivacija, prijava, podesavanja/jedinice, podesavanja/cene, kalendar, rezervacije/nova
```

---

### Task 1: Monorepo, CI na NAS-u i zelen prazan test

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.npmrc`, `.gitattributes`
- Create: `apps/hotel-api/{package.json,tsconfig.json,nest-cli.json,jest.config.ts,src/main.ts,src/app.module.ts,src/health.controller.ts,src/health.controller.spec.ts}`
- Create: `infrastructure/nas/ci-compose.yml`, `infrastructure/nas/ci.sh`
- Modify: `CLAUDE.md` (Docker na NAS-u: dozvoljeni projekti `claude-hotel` i `claude-hotel-ci`; komanda za testove)
- Modify: `.gitignore` (`dist/`, `.next/`, `.turbo/`)

**Interfaces:**
- Produces: `pnpm test` i `pnpm typecheck` u korenu; `infrastructure/nas/ci.sh [ref]` vraća exit 0 samo kad su testovi i typecheck zeleni. `GET /health` → `200 {"status":"ok"}`.

- [ ] **Step 1:** Koren: `packageManager: "pnpm@9.6.0"`, `engines.node: ">=20"`, skripte `test` (`turbo run test --concurrency=1`), `typecheck`, `build`. `.npmrc`: `@platform:registry=http://192.168.1.199:4873/`. `.gitattributes`: `* text=auto eol=lf` (fajlovi idu na Linux preko `git archive`).
- [ ] **Step 2:** `ci-compose.yml`, projekat `name: claude-hotel-ci`, po obrascu `D:\Claude\Admin Panel\infra\staging\ci-compose.yml`:
  - `hotel-ci-runner-claude`: `node:20-bookworm-slim`, `command: ['sleep','infinity']`, `init: true`, `user: '${CI_UID:?}:${CI_GID:?}'`, `HOME=/tmp`, `npm_config_store_dir=/ci/hotel/pnpm-store`, volume-i `/volume1/ci/hotel:/ci/hotel` i `/volume1/ci/.npmrc:/tmp/.npmrc:ro`.
  - `hotel-postgres-test-claude`: `postgres:16-alpine`, `POSTGRES_PASSWORD: postgres`, `fsync=off`, `synchronous_commit=off`, `full_page_writes=off`, tmpfs `size=1g`, bez objavljenog porta, healthcheck `pg_isready`.
- [ ] **Step 3:** `ci.sh [ref]` (bash, `set -euo pipefail`): `git archive` refa u `/volume1/ci/hotel/src` (briše samo taj direktorijum), `up -d --wait` za `ci-compose.yml`, zatim `docker exec -w /ci/hotel/src -e DATABASE_URL=postgres://postgres:postgres@hotel-postgres-test-claude:5432/postgres hotel-ci-runner-claude sh -c 'corepack … && pnpm install --frozen-lockfile && pnpm build && pnpm test && pnpm typecheck'`. Pristup kao u Admin Panel `deploy.sh` (`claude-ci@192.168.1.199`, ključ `~/.ssh/synology_claude_ci`). Opcija `--lock`: umesto `--frozen-lockfile` radi `pnpm install --no-frozen-lockfile` i vraća `pnpm-lock.yaml` na računar preko `ssh … cat`.
- [ ] **Step 4:** Test `health.controller.spec.ts`: `GET /health` vraća `200` i `{ status: 'ok' }`. Implementacija `HealthController`.
- [ ] **Step 5:** `infrastructure/nas/ci.sh --lock`, zatim `infrastructure/nas/ci.sh`. Očekivano: lockfile napravljen, `Tests: 1 passed`, exit 0.
- [ ] **Step 6:** Commit `Set up the monorepo and run its tests on the NAS` (sa `pnpm-lock.yaml`).

---

### Task 2: Baza: migrator, objekat, audit, test baza po radniku

**Files:**
- Create: `apps/hotel-api/src/db/{pool.ts,migrate.ts,migrate-cli.ts,schema.ts,database.module.ts,migrations/0001_foundation.sql}`
- Create: `apps/hotel-api/src/common/{domain-error.ts,audit.service.ts,property-context.ts}`
- Create: `apps/hotel-api/test/db.ts`
- Test: `apps/hotel-api/src/db/migrate.spec.ts`, `apps/hotel-api/src/common/audit.service.spec.ts`

**Interfaces:**
- Produces:
  - `migrate(pool: Pool, dir?: string): Promise<string[]>` — isto ponašanje kao Admin Panel migrator (advisory lock `7_301_001`, fajl + red u `schema_migrations` u jednoj transakciji).
  - `createTestDb(): Promise<{ pool: Pool; db: NodePgDatabase<typeof schema>; truncate(): Promise<void>; close(): Promise<void> }>` — baza `hotel_test_${JEST_WORKER_ID}` na `DATABASE_URL`, pravi se i migrira jednom po radniku; `truncate()` prazni sve tabele osim `schema_migrations`.
  - `class DomainError extends Error { constructor(code: string, message: string, status: number, details?: Record<string, unknown>) }` + Nest filter koji vraća `{ code, message, details }`.
  - `AuditService.record(tx, e: { propertyId: string | null; actorUserId: string | null; action: string; entity: string; entityId: string; before?: unknown; after?: unknown }): Promise<void>`.
  - `PropertyContext.id(): Promise<string>` — jedini objekat instalacije; baca `DomainError('property_missing', …, 409)` pre podešavanja.
- `0001_foundation.sql`: `CREATE EXTENSION IF NOT EXISTS btree_gist;` tabele `property(id uuid pk default gen_random_uuid(), name text not null, timezone text not null default 'Europe/Belgrade', currency char(3) not null default 'RSD', languages text[] not null default '{sr,en}', municipality text, created_at timestamptz)`, `legal_profile(property_id pk/fk, kind text check in ('legal_entity','entrepreneur','natural_person'), tax_id text, registry_id text, vat_payer boolean not null default false)` i `audit_log(id bigserial, property_id uuid null, actor_user_id uuid null, action text, entity text, entity_id text, before jsonb, after jsonb, at timestamptz default now())`.

- [ ] **Step 1:** Testovi: `migrate.spec.ts` — „primeni sve fajlove jednom, drugi poziv vraća []"; „neispravan fajl ne ostavlja ni tabelu ni red u schema_migrations"; „dva paralelna poziva primene fajl tačno jednom". `audit.service.spec.ts` — „red se upisuje u istoj transakciji i nestaje kad se transakcija poništi".
- [ ] **Step 2:** `ci.sh` → FAIL (moduli ne postoje).
- [ ] **Step 3:** Implementacija po Interfaces bloku; `migrate-cli.ts` migrira `DATABASE_URL` i izlazi; `main.ts` migrira pre `listen`.
- [ ] **Step 4:** `ci.sh` → PASS.
- [ ] **Step 5:** Commit `Add the database foundation with migrations and audit`.

---

### Task 3: Licenca: klijent, skladište i aktivacija

**Files:**
- Create: `apps/hotel-api/src/licensing/{central-admin.client.ts,licence.store.ts,activation.service.ts,secret-box.ts}`, `migrations/0002_licence.sql`
- Create: `apps/hotel-api/test/fake-central-admin.ts`
- Test: `apps/hotel-api/src/licensing/activation.service.spec.ts`, `central-admin.client.spec.ts`

**Interfaces:**
- Consumes: `@platform/licensing` (`signRequest`, `acceptKeySet`, `evaluateLicense`, `EMPTY_MEMORY`, tipovi), Admin Panel rute: `POST /v1/installations/activate` (`{code, publicKey}` → `{installationId, license, keySet}`), `GET /v1/license` (ETag = `"<revision>"`, `If-None-Match` → 304), `POST /v1/heartbeat` (telo tačno `{version}` → `{serverTime, latestRevision}`), `GET /v1/keys?since=<issued_at>`.
- Produces:
  - `CentralAdminClient` sa `activate(code, publicKey)`, `fetchLicence(auth, heldRevision?)` → `{ status: 'unchanged' } | { status: 'changed', envelope }`, `heartbeat(auth, version)`, `keySetsSince(issuedAt)`. Greške: `ParentRefusal` (4xx, sa kodom iz tela) i `ParentUnavailable` (mreža, 5xx, timeout 15 s). Odbija `http://` URL osim kad je `CENTRAL_ADMIN_ALLOW_HTTP=true`.
  - `LicenceStore` (tabela `installation_licence`, jedan red): `installation_id`, `private_seed_enc` (AES-256-GCM sa `HOTEL_SECRET_KEY`, 32 bajta base64url), `envelope jsonb`, `key_set jsonb`, `memory jsonb`, `updated_at`. Metode `get()`, `saveActivation(...)`, `saveLicence(envelope, memory)`, `saveKeySet(keySet)`, `saveMemory(memory)`.
  - `ActivationService.activate(code: string): Promise<void>` — pravi Ed25519 par (`node:crypto` `generateKeyPairSync('ed25519')`, seed = JWK `d`, javni = JWK `x`), šalje aktivaciju, prihvata `keySet` preko `acceptKeySet` od korena `HOTEL_ROOT_KEYSET`, licencu proverava `evaluateLicense` sa `installationId` iz odgovora; čuva samo ako je stanje `VALID` ili `GRACE`, inače `DomainError('activation_rejected', …, 422)` sa razlogom. Već aktivirana instalacija → `409 already_activated`.
  - `fake-central-admin.ts`: `startFakeCentralAdmin(): Promise<{ url: string; rootKeySet: SignedKeySet; issueCode(opts?): string; setLicence(patch): void; setDown(down: boolean): void; requests: RecordedRequest[]; close() }>` — potpisuje ključeve i licence pravim `@platform/licensing` funkcijama i proverava potpis zahteva (`verifyRequestSignature`).
- Konfiguracija (env): `CENTRAL_ADMIN_URL`, `CENTRAL_ADMIN_ALLOW_HTTP`, `HOTEL_ROOT_KEYSET` (izlaz `GET /v1/keys`), `HOTEL_SECRET_KEY`. Bez korena ili tajnog ključa API se pokreće, ali aktivacija vraća `503 licensing_not_configured`.

- [ ] **Step 1:** Testovi protiv lažnog Admin Panela:
  - „ispravan kod: sačuvani installation_id i licenca, seed u bazi nije čitljiv bez HOTEL_SECRET_KEY";
  - „key set koji ne vodi od korena: ništa se ne čuva, 422 activation_rejected";
  - „licenca za drugu instalaciju (wrong_installation): ništa se ne čuva";
  - „Admin Panel nedostupan: 503 central_admin_unavailable, kod se ponovo može upotrebiti";
  - „druga aktivacija: 409 already_activated";
  - klijent: „heartbeat i license zahtevi nose X-Installation-Id, X-Timestamp, X-Nonce, X-Signature koje lažni server prihvata"; „http URL bez dozvole: greška pri pokretanju".
- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija; obrazac je POS `licence-client.ts` na grani `phase-2-pos-child` (samo za čitanje, ne kopirati fajl, pisati za Postgres).
- [ ] **Step 4:** `ci.sh` → PASS. Proba brisanjem: ukloni proveru `acceptKeySet` → test „key set koji ne vodi od korena" mora pasti; vrati.
- [ ] **Step 5:** Commit `Activate the installation against the Central Admin Panel`.

---

### Task 4: Licenca u radu: osvežavanje, guard po akciji, siguran režim, limiti

**Files:**
- Create: `apps/hotel-api/src/licensing/{licence.service.ts,licensed-action.ts,licence.guard.ts,safe-mode.ts,licence.controller.ts}`
- Test: `licence.service.spec.ts`, `licence.guard.spec.ts`, `test/licensed-routes.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `LicenceService.snapshot(): LicenceSnapshot` — `{ activated: boolean; state: 'VALID'|'GRACE'|'EXPIRED'|'INVALID'|'NOT_ACTIVATED'; modules: string[]; limits: Record<string, number|null>; validUntil?: string; graceUntil?: string; reason?: string }`; procena se kešira 60 s i odmah posle svake promene licence.
  - `LicenceService.start()` / `stop()`: heartbeat na 5 min (`version` iz `package.json`), `serverTime` → `memory.lastServerTime`; ako `latestRevision` > držane, `fetchLicence`; key set se osvežava jednom dnevno (`keySetsSince(keySet.issued_at)` → `acceptKeySet`). Neuspeh mreže ne menja stanje.
  - `LicenceService.assertLimit(key: 'rooms'|'users', wanted: number): void` → `DomainError('limit_exceeded', …, 403, { key, limit, wanted })`; `null` = neograničeno.
  - Dekoratori `@LicensedAction(module: string, action: string)` i `@Unlicensed()`; globalni `LicenceGuard` koristi `createAccessResolver({ safeModeAllowed: SAFE_MODE_ALLOWED })`. Odbijanje: `403 { code: reason }` (`not_activated`, `invalid_license`, `module_not_licensed`, `safe_mode_blocked`, `expired_hard_lock`).
  - `SAFE_MODE_ALLOWED` u `safe-mode.ts` za 1a: `calendar.view`, `reservation.view`, `unit.view`, `rate.view`, `user.view`. Komentar: spec §9, dopuna u 1b/1c (`stay.check_out`, `folio.pay`, `eturista.check_out`, `export.run`).
  - `GET /licence` (`@Unlicensed`, potrebna prijava) → `LicenceSnapshot` bez potpisa i ključeva.
- [ ] **Step 1:** Testovi:
  - servis (lažni Admin Panel, lažni sat): „heartbeat sa većom revizijom povlači novu licencu"; „Admin Panel pao: stanje ostaje VALID dok ne prođe valid_until, zatim GRACE, zatim EXPIRED"; „sat vraćen unazad ispod serverTime: INVALID clock_rollback"; „rotacija ključa: novi key set prihvaćen, licenca potpisana novim ključem važi".
  - guard: tabela stanja × akcija iz spec §7 resolvera; „EXPIRED + safe_mode: reservation.view dozvoljen, reservation.create 403 safe_mode_blocked"; „modul nije u licenci: 403 module_not_licensed čak i u sigurnom režimu"; „nije aktivirano: 403 not_activated".
  - `licensed-routes.e2e-spec.ts`: prolazi kroz sve rute Nest aplikacije i pada ako ruta nema ni `@LicensedAction` ni `@Unlicensed`.
  - limit (direktno nad `assertLimit`, jedinice još ne postoje): „rooms = 2, wanted = 3: limit_exceeded sa key, limit, wanted"; „rooms = null: bez ograničenja"; „ključ koga nema u licenci: limit_exceeded" (nepoznato = zatvoreno).
- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija; `/health` dobija `@Unlicensed()` (i `@Public()` u Tasku 5).
- [ ] **Step 4:** `ci.sh` → PASS. Proba brisanjem: ukloni `APP_GUARD` registraciju → e2e „reservation.create u sigurnom režimu" mora pasti; vrati.
- [ ] **Step 5:** Commit `Check the licence per action and keep it fresh`.

---

### Task 5: Korisnici, prijava, TOTP i prvo podešavanje

**Files:**
- Create: `apps/hotel-api/src/auth/{password.ts,totp.ts,sessions.service.ts,users.service.ts,users.controller.ts,auth.guard.ts,auth.controller.ts,setup.service.ts,setup.controller.ts}`, `migrations/0003_auth.sql`
- Test: `password.spec.ts`, `totp.spec.ts`, `test/auth.e2e-spec.ts`, `test/setup.e2e-spec.ts`

**Interfaces:**
- `0003_auth.sql`: `app_user(id, property_id, email citext unique, name, role text check in ('owner','manager','receptionist','housekeeping'), password_hash text, totp_secret text null, totp_last_step bigint null, active boolean, created_at)`, `user_session(id, user_id, token_hash bytea unique, expires_at, absolute_expires_at, created_at)`, `setup_token(token_hash bytea, created_at)` (najviše jedan red).
- Produces:
  - `hashPassword(p: string): Promise<string>` / `verifyPassword(p, hash): Promise<boolean>` — `node:crypto` scrypt (`N=2^15, r=8, p=1`, so 16 B, ključ 64 B), zapis `scrypt$N$r$p$salt$hash`; najmanje 10 znakova.
  - `totpVerify(secretBase32: string, code: string, now: Date, lastStep: number | null): number | null` — RFC 6238, SHA-1, 30 s, 6 cifara, prozor ±1 korak; vraća korišćeni korak, a korak `<= lastStep` odbija (zaštita od ponovne upotrebe).
  - `POST /auth/login {email, password, totp?}` → kolačić `hotel_session` (`HttpOnly`, `SameSite=Strict`, `Secure` kad je zahtev https), sesija 12 h neaktivnosti, 7 dana apsolutno; `owner`/`manager` bez ispravnog TOTP-a → `401 totp_required`. Pet neuspeha za isti email u 15 min → `429`.
  - `POST /auth/logout`, `GET /auth/me` → `{ id, email, name, role }`.
  - `AuthGuard` (globalni, posle `LicenceGuard`-a nije bitan redosled odbijanja; rute `@Public()` ga preskaču) i `@Roles(...roles)`.
  - Prvo podešavanje (`@Public`, `@Unlicensed`, radi samo dok `app_user` nema redova): pri prvom pokretanju API pravi `setup_token`, upisuje ga u log jednom (`[hotel-api] Kod za prvo podešavanje: XXXX-XXXX-XXXX`), čuva samo heš. `GET /setup/status` → `{ activated, hasOwner, hasProperty }`. `POST /setup/activate {setupToken, code}` → `ActivationService.activate`. `POST /setup/owner {setupToken, propertyName, legalKind, email, name, password}` → pravi `property`, `legal_profile`, vlasnika i vraća `{ totpUri }` (`otpauth://totp/Hotel:<email>?secret=…&issuer=Hotel`); posle toga `setup_token` se briše i rute vraćaju `410 setup_done`.
  - Korisnici (`@LicensedAction('hotel.core','user.manage')`, `@Roles('owner','manager')`): `POST /users`, `PATCH /users/:id` (uloga, aktivan); `assertLimit('users', aktivni + 1)`.
- [ ] **Step 1:** Testovi:
  - „pogrešan setup token: 403, ništa se ne pravi"; „posle vlasnika: /setup/* vraća 410";
  - „menadžer bez TOTP-a: 401 totp_required; sa TOTP-om: 200 i kolačić"; „isti TOTP kod drugi put: 401";
  - „recepcionar ne može da pravi korisnike: 403"; „ruta bez sesije: 401";
  - „isteklo 12 h neaktivnosti: 401"; „šesti pokušaj u 15 min: 429";
  - `totp.spec.ts` sa RFC 6238 vektorima za SHA-1 (`59 s → 94287082` skraćeno na 6 cifara `287082`).
- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija; `AuditService.record` za login, logout, pravljenje i izmenu korisnika (bez lozinki i tajni u `after`).
- [ ] **Step 4:** `ci.sh` → PASS. Proba brisanjem: ukloni proveru `lastStep` → test „isti TOTP kod drugi put" mora pasti; vrati.
- [ ] **Step 5:** Commit `Add users, sessions with TOTP and first-run setup`.

---

### Task 6: Jedinice, tipovi i blokade

**Files:**
- Create: `apps/hotel-api/src/units/{units.service.ts,units.controller.ts}`, `src/inventory/{inventory.service.ts,unit-blocks.service.ts,unit-blocks.controller.ts}`, `migrations/0004_units_inventory.sql`
- Test: `test/units.e2e-spec.ts`, `src/inventory/inventory.service.spec.ts`

**Interfaces:**
- `0004`: `unit_type(id, property_id, code text, name jsonb /*{sr,en}*/, capacity int check > 0, beds text, description jsonb, active, unique(property_id, code))`; `unit(id, property_id, name text, unit_type_id uuid null, address text, municipality text, eturista_object_id text, active, cleanliness text default 'clean' check in ('clean','dirty','inspected'), unique(property_id, name))`; `unit_block(id, property_id, unit_id, period daterange not null, reason text check in ('maintenance','owner_use','other'), note text, created_by)` sa `EXCLUDE USING gist (unit_id WITH =, period WITH &&)`; `inventory_day(property_id, scope_kind text check in ('unit_type','unit'), scope_id uuid, day date, total int, sold int default 0, blocked int default 0, primary key(property_id, scope_kind, scope_id, day), check (sold >= 0 and blocked >= 0 and sold + blocked <= total))`.
- Pravilo opsega: jedinica sa tipom troši opseg `('unit_type', unit_type_id)`; jedinica bez tipa troši `('unit', unit_id)` sa `total = 1`.
- Produces:
  - `InventoryService.scopeOfUnit(tx, unitId): Promise<Scope>`; `type Scope = { kind: 'unit_type' | 'unit'; id: string }`.
  - `InventoryService.lockDays(tx, propertyId, scope, from: string, to: string): Promise<InventoryDay[]>` — ubacuje nedostajuće dane (`INSERT … ON CONFLICT DO NOTHING`, `total` iz trenutnih aktivnih jedinica) pa zaključava `SELECT … FOR UPDATE ORDER BY day`; `to` je isključiv.
  - `InventoryService.take(tx, propertyId, scope, from, to, column: 'sold'|'blocked', delta: 1 | -1): Promise<void>` — posle `lockDays`; kad bi `sold + blocked > total`, baca `DomainError('no_availability', …, 409, { day })` sa prvim punim danom.
  - `InventoryService.recomputeTotal(tx, propertyId, scope): Promise<void>` — za dane od danas nadalje; kad bi novi `total` pao ispod `sold + blocked`, baca `409 inventory_conflict { day }`.
  - API (`@LicensedAction('hotel.core', 'unit.manage' | 'unit.view')`): `GET/POST /unit-types`, `PATCH /unit-types/:id`, `GET/POST /units`, `PATCH /units/:id` (deaktivacija i promena tipa idu kroz `recomputeTotal` za stari i novi opseg u istoj transakciji); pravljenje ili aktiviranje jedinice zove `assertLimit('rooms', aktivne + 1)`.
  - `POST /units/:id/blocks {from, to, reason, note}` / `DELETE /units/:id/blocks/:blockId`: zaključava red jedinice (`SELECT … FOR UPDATE` na `unit`), zatim `take(…, 'blocked', +1)` (brisanje: `-1`). Exclusion constraint između blokada → `409 block_overlap`. Provera preklapanja sa boravkom (`409 unit_occupied`) dodaje se u Task 9, kad tabela `stay` postoji.
- [ ] **Step 1:** Testovi:
  - „tip sa 3 aktivne jedinice: total = 3 za novi dan"; „jedinica bez tipa: total = 1";
  - „deaktivacija jedinice kad je za neki budući dan sold = total: 409 inventory_conflict sa tim danom, jedinica ostaje aktivna";
  - „promena tipa jedinice prebacuje total sa starog na novi tip";
  - „blokada povećava blocked; preklapanje dve blokade iste jedinice: 409 block_overlap";
  - „četvrta jedinica uz limit rooms = 3: 403 limit_exceeded".
- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija; audit za svaku promenu.
- [ ] **Step 4:** `ci.sh` → PASS. Proba brisanjem: ukloni proveru u `recomputeTotal` → test deaktivacije mora pasti (CHECK constraint daje 500, ne 409); vrati.
- [ ] **Step 5:** Commit `Add units, unit types, blocks and the inventory ledger`.

---

### Task 7: Zaštita od overbookinga pod konkurencijom

**Files:**
- Test: `apps/hotel-api/test/overbooking.e2e-spec.ts`
- Modify: `src/inventory/inventory.service.ts` (samo ako test otkrije propust)

**Interfaces:**
- Consumes: `InventoryService.lockDays`, `take` (Task 6). Ovaj task proverava Task 6 na pravom Postgres-u pre nego što ga rezervacije koriste.

- [ ] **Step 1:** Testovi sa odvojenim konekcijama iz `pool`-a (ne istom transakcijom):
  - „20 paralelnih take(sold, +1) na tip sa total = 5 za 3 noći: tačno 5 uspeha, 15 puta no_availability, nijedan dan nema sold > 5";
  - „dva preklapajuća opsega datuma u suprotnom redosledu: nema deadlock-a (oba završe za < 5 s)";
  - „take i blokada iste noći paralelno na total = 1: tačno jedno uspe".
- [ ] **Step 2:** `ci.sh`. Očekivano PASS ako je Task 6 tačan; ako ne, popraviti `InventoryService` dok ne prođe.
- [ ] **Step 3:** Proba brisanjem: ukloni `FOR UPDATE` iz `lockDays` → prvi test mora pasti (ili CHECK constraint baca grešku koju test ne očekuje); vrati.
- [ ] **Step 4:** Commit `Prove the inventory ledger holds under concurrent sales`.

---

### Task 8: Osnovni cenovnik i obračun boravka

**Files:**
- Create: `apps/hotel-api/src/rates/{rates.service.ts,rates.controller.ts,quote.ts}`, `migrations/0005_rates.sql`
- Test: `src/rates/quote.spec.ts`, `test/rates.e2e-spec.ts`

**Interfaces:**
- `0005`: `rate_plan(id, property_id, code, name jsonb, board text not null default 'RO' check in ('RO','BB','HB','FB'), cancellation_policy jsonb, discount_7_pct int not null default 0 check 0..100, discount_30_pct int not null default 0 check 0..100, active, unique(property_id, code))`; `rate_day(property_id, rate_plan_id, scope_kind, scope_id, day, price_minor bigint check >= 0, closed boolean default false, primary key(property_id, rate_plan_id, scope_kind, scope_id, day))`. Kolone `min_stay`, `cta`, `ctd` i `derived_from_id` ulaze sa `hotel.rates_advanced`, ne u 1a.
- Produces:
  - `quoteStay(input: { nights: Array<{ day: string; priceMinor: number | null; closed: boolean }>; discount7Pct: number; discount30Pct: number; currency: 'RSD' }): { ok: true; nights: Array<{ day: string; price: Money }>; total: Money } | { ok: false; reason: 'price_missing' | 'closed'; day: string }` — čista funkcija; popust se bira po broju noći (`>= 30` → `discount30Pct`, inače `>= 7` → `discount7Pct`), primenjuje se po noći preko `multiply(price, (100 - pct) / 100)`, `total` je zbir noći.
  - `RatesService.quote(tx, propertyId, ratePlanId, scope, arrival, departure)` → rezultat `quoteStay`.
  - API: `GET/POST /rate-plans`, `PATCH /rate-plans/:id` (`rate.manage`/`rate.view`); `PUT /rate-plans/:id/days {scope, from, to, priceMinor?, closed?}` postavlja opseg dana jednim upitom (`rate.manage`); `GET /rate-plans/:id/days?scope&from&to`. Najviše 731 dan po zahtevu (`422 range_too_long`).
- [ ] **Step 1:** Testovi `quote.spec.ts`: „6 noći bez popusta"; „7 noći × 10.000,00 RSD sa 10%: svaka noć 9.000,00, ukupno 63.000,00"; „30 noći koristi popust za 30, ne za 7"; „noć bez cene: price_missing sa tim danom"; „zatvoren dan: closed sa tim danom"; „cena 0 je dozvoljena samo kad je eksplicitno upisana". E2E: „recepcionar ne može da menja cene: 403"; „u sigurnom režimu PUT days: 403 safe_mode_blocked, GET radi".
- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija.
- [ ] **Step 4:** `ci.sh` → PASS.
- [ ] **Step 5:** Commit `Add the base price list and stay quotes`.

---

### Task 9: Rezervacije: jedna funkcija za svaki izvor

**Files:**
- Create: `apps/hotel-api/src/reservations/{reservations.service.ts,reservations.controller.ts,stay-dates.ts}`, `migrations/0006_reservations.sql`
- Test: `src/reservations/stay-dates.spec.ts`, `test/reservations.e2e-spec.ts`

**Interfaces:**
- `0006`: `guest(id, property_id, first_name, last_name, email citext null, phone text null, language text default 'sr', created_at)` (polja za e-Turistu dolaze u 1c); `reservation(id, property_id, number text, source text check in ('front_desk','phone','website','widget','api','ota'), channel text null, external_id text null, holder_guest_id, status text check in ('requested','confirmed','cancelled','no_show'), guarantee text null, note text, version int not null default 1, created_by, created_at, unique(property_id, number))` + `unique(property_id, channel, external_id) where external_id is not null`; `reservation_counter(property_id, year int, last int, primary key(property_id, year))`; `stay(id, property_id, reservation_id, unit_type_id null, unit_id null, arrival date, departure date, adults int check >= 1, children int default 0, rate_plan_id, status text check in ('expected','in_house','checked_out','cancelled'), check (departure > arrival))` + `EXCLUDE USING gist (unit_id WITH =, daterange(arrival, departure) WITH &&) WHERE (unit_id IS NOT NULL AND status IN ('expected','in_house'))`; `stay_night(stay_id, property_id, day, price_minor bigint, rate_plan_id, primary key(stay_id, day))`.
- Produces:
  - `validateStayDates(arrival: string, departure: string, today: string): { ok: true; nights: number } | { ok: false; reason: 'departure_not_after_arrival' | 'too_long' | 'arrival_in_past' | 'bad_date' }` — najviše 365 noći; `today` je lokalni datum objekta.
  - `ReservationsService.book(input: BookInput, actor: Actor): Promise<{ reservationId: string; number: string }>`; `BookInput = { source: ReservationSource; channel?: string; externalId?: string; holder: { firstName: string; lastName: string; email?: string; phone?: string; language?: string }; note?: string; stays: Array<{ unitTypeId?: string; unitId?: string; arrival: string; departure: string; adults: number; children?: number; ratePlanId: string }> }`. U jednoj transakciji, za svaki boravak: datumi → opseg (iz `unitId` preko `scopeOfUnit`, inače `unitTypeId`) → zaključavanje svih opsega u stalnom redosledu (`scope_kind, scope_id`, pa dani) → `take(sold, +1)` → `RatesService.quote` (neuspeh = `422 price_missing|closed { day }`) → `stay` (+ `unit_id`; kršenje exclusion constraint-a `23P01` → `409 unit_taken`; preklapanje sa blokadom te jedinice → `409 unit_blocked`) → `stay_night` snimci. Broj: `R-{godina dolaska prvog boravka}-{6 cifara}` iz `reservation_counter`. Isti `(channel, externalId)` drugi put vraća postojeću rezervaciju (idempotentnost za OTA i sajt kasnije).
  - `ReservationsService.cancel(id, expectedVersion: number, actor)` → status `cancelled`, boravci `cancelled`, `take(sold, -1)` za svaku noć, `version + 1`; pogrešna verzija → `409 version_conflict`.
  - `ReservationsService.assignUnit(stayId, unitId, expectedVersion, actor)` — jedinica mora biti istog tipa kao boravak (`422 unit_type_mismatch`); bez promene inventara.
  - Dopuna `UnitBlocksService` iz Taska 6: posle zaključavanja reda jedinice, blokada koja se preklapa sa boravkom te jedinice u statusu `expected`/`in_house` → `409 unit_occupied`. `book` i `assignUnit` zaključavaju isti red jedinice pre provere blokade, pa se blokada i dodela ne mogu mimoići.
  - API: `POST /reservations` (`reservation.create`), `GET /reservations?from&to&status&q` i `GET /reservations/:id` (`reservation.view`), `POST /reservations/:id/cancel {version}` (`reservation.cancel`), `POST /stays/:id/assign-unit {unitId, version}` (`reservation.update`).
- [ ] **Step 1:** Testovi:
  - `stay-dates.spec.ts`: sva četiri razloga i granica od 365 noći;
  - e2e: „rezervacija dva boravka: sold +1 za oba opsega, stay_night snimak cene"; „nema cene za jednu noć: 422 price_missing, ništa nije upisano (ni sold, ni broj)"; „jedinica zauzeta: 409 unit_taken"; „jedinica blokirana: 409 unit_blocked"; „blokada preko postojećeg boravka: 409 unit_occupied"; „otkazivanje vraća sold i oslobađa jedinicu za novu rezervaciju"; „otkazivanje sa starom verzijom: 409 version_conflict"; „isti channel+externalId dva puta: jedna rezervacija"; „broj rezervacija ide R-2027-000001, R-2027-000002 po godini dolaska";
  - konkurencija: „10 paralelnih book na poslednju jedinicu tipa: tačno 1 uspeh".
- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija; audit za book, cancel, assign.
- [ ] **Step 4:** `ci.sh` → PASS. Proba brisanjem: ukloni `EXCLUDE` iz migracije u test bazi → „jedinica zauzeta" mora pasti; vrati.
- [ ] **Step 5:** Commit `Book, cancel and assign stays through one guarded path`.

---

### Task 10: Kalendar recepcije (API)

**Files:**
- Create: `apps/hotel-api/src/calendar/{calendar.service.ts,calendar.controller.ts}`
- Test: `test/calendar.e2e-spec.ts`

**Interfaces:**
- Produces: `GET /calendar?from=YYYY-MM-DD&to=YYYY-MM-DD` (`calendar.view`, najviše 62 dana, `to` isključiv) →
  ```ts
  {
    days: string[];
    availability: Array<{ scope: Scope; label: string; free: number[] }>; // po danu: total - sold - blocked
    units: Array<{ id: string; name: string; unitTypeId: string | null; cleanliness: string;
                   bars: Array<{ kind: 'stay'; stayId: string; reservationId: string; number: string; guest: string;
                                 arrival: string; departure: string; status: string }
                              | { kind: 'block'; blockId: string; from: string; to: string; reason: string }> }>;
    unassigned: Array<{ stayId: string; reservationId: string; number: string; guest: string; unitTypeId: string;
                        arrival: string; departure: string }>;
  }
  ```
  Dani bez reda u `inventory_day` računaju se iz trenutnih jedinica (bez upisa: GET ne sme da piše).
- [ ] **Step 1:** Testovi: „boravak preko granice opsega se prikazuje skraćen na opseg"; „nedodeljen boravak je u unassigned, ne u units"; „free za dan bez inventory_day reda = broj aktivnih jedinica tipa"; „opseg od 63 dana: 422"; „GET ne upisuje redove u inventory_day".
- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija (dva do tri upita, bez N+1 po jedinici).
- [ ] **Step 4:** `ci.sh` → PASS.
- [ ] **Step 5:** Commit `Serve the front-desk calendar`.

---

### Task 11: hotel-web: aktivacija, prijava i podešavanje jedinica i cena

**Files:**
- Create: `apps/hotel-web/{package.json,next.config.ts,tsconfig.json,vitest.config.ts}`, `src/lib/api.ts`, `src/app/{layout.tsx,aktivacija/page.tsx,prijava/page.tsx,podesavanja/jedinice/page.tsx,podesavanja/cene/page.tsx}`, `src/components/licence-banner.tsx`
- Test: `src/lib/api.test.ts`, `src/app/**/page.test.tsx`

**Interfaces:**
- Consumes: API iz Taskova 3–8.
- Produces:
  - `next.config.ts`: rewrite `/api/:path*` → `${HOTEL_API_URL}/:path*` (kolačić sesije ostaje na istom originu).
  - `api<T>(path: string, init?: RequestInit): Promise<T>` — baca `ApiError { status, code, message, details }`; `401` vodi na `/prijava`, `GET /setup/status` sa `activated: false` ili `hasOwner: false` vodi na `/aktivacija`.
  - Poruke za kodove grešaka u jednom rečniku `src/lib/messages.ts` (npr. `no_availability` → „Nema slobodnih jedinica za {day}.", `safe_mode_blocked` → „Licenca je istekla. Sistem radi u sigurnom režimu: pregled je dozvoljen, izmene nisu.").
  - `/aktivacija`: korak 1 kod za podešavanje + aktivacioni kod; korak 2 objekat, pravni oblik, vlasnik, lozinka; korak 3 QR za TOTP (`totpUri`) i potvrda prvim kodom.
  - `LicenceBanner`: prikazuje `GRACE` (do kada) i `EXPIRED` (siguran režim) iz `GET /licence`.
  - `/podesavanja/jedinice`: lista i forma za tipove i jedinice, deaktivacija, blokade. `/podesavanja/cene`: planovi i mreža cena po danu i opsegu (postavljanje opsega dana jednom akcijom).
- [ ] **Step 1:** Testovi (Vitest + Testing Library, `fetch` lažiran): „401 vodi na /prijava"; „aktivacija: pogrešan setup kod prikazuje poruku iz rečnika"; „menadžer bez TOTP-a dobija polje za kod posle totp_required"; „LicenceBanner u EXPIRED prikazuje tekst sigurnog režima"; „mreža cena šalje jedan PUT za izabrani opseg dana".
- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija; UI na srpskom latinicom, mobilni prikaz radi od 375 px.
- [ ] **Step 4:** `ci.sh` → PASS.
- [ ] **Step 5:** Commit `Add activation, sign-in and setup screens`.

---

### Task 12: hotel-web: kalendar i nova rezervacija

**Files:**
- Create: `apps/hotel-web/src/app/kalendar/page.tsx`, `src/app/rezervacije/nova/page.tsx`, `src/app/rezervacije/[id]/page.tsx`, `src/components/calendar-grid.tsx`
- Test: `src/components/calendar-grid.test.tsx`, `src/app/rezervacije/nova/page.test.tsx`

**Interfaces:**
- Consumes: `GET /calendar` (Task 10), `POST /reservations`, `POST /reservations/:id/cancel`, `POST /stays/:id/assign-unit` (Task 9).
- Produces: kalendar 14 ili 31 dan (izbor), redovi po jedinici sa trakama boravaka i blokada, red „Nedodeljeno", red slobodnih po tipu; klik na prazno polje otvara novu rezervaciju sa jedinicom i datumom; prevlačenje nedodeljenog boravka na jedinicu zove `assign-unit`. Nova rezervacija prikazuje obračun pre potvrde (iz odgovora greške ili ponovnim pozivom `quote`: dodati `POST /reservations/quote` sa istim telom kao `book`, `reservation.view`, bez upisa).
- [ ] **Step 1:** Testovi: „traka boravka zauzima tačno broj noći"; „boravak koji počinje pre opsega počinje od prve kolone"; „409 no_availability prikazuje poruku sa datumom i ne zatvara formu"; „u sigurnom režimu dugme Nova rezervacija je onemogućeno, kalendar se prikazuje".
- [ ] **Step 2:** Dodati `POST /reservations/quote` u API sa e2e testom „quote ne menja sold"; `ci.sh` → FAIL za web testove.
- [ ] **Step 3:** Implementacija.
- [ ] **Step 4:** `ci.sh` → PASS.
- [ ] **Step 5:** Commit `Show the calendar and take reservations at the front desk`.

---

### Task 13: Manifest proizvoda, slika i staging na NAS-u

**Files:**
- Create: `product/manifest.json`, `product/manifest.spec.ts` (u `apps/hotel-api/test/`), `scripts/publish-manifest.mjs`
- Create: `infrastructure/docker/Dockerfile`, `infrastructure/nas/deploy.sh`, `scripts/smoke-1a.mjs`
- Modify: `infrastructure/docker/docker-compose.yml` (servisi `api`, `web`), `.env.example`, `CLAUDE.md` (deploy i staging adrese)

**Interfaces:**
- `manifest.json` po šemi Admin Panela (`apps/admin-api/src/products/manifest.ts`, samo čitanje): `version: "0.1.0"`, `expiry_modes: ["safe_mode"]`, `modules` = svi ključevi iz spec §4.1 i §4.2 sa `depends_on` iz kolone „Zavisi od", `core: true` za `hotel.core`, `hotel.folio`, `hotel.eturista`, `required_by_profile: ["legal_entity","entrepreneur"]` za `hotel.fiscal_rs`; `limit_types` = ključevi iz §4.3 (`rooms`, `users`, `devices`, `lock_encoders`, `website_languages`, `gallery_storage_gb`, `owners`, `installations`); `metric_types: []`.
- `publish-manifest.mjs`: `POST {CENTRAL_ADMIN_URL}/v1/products/hotel/manifests` sa `Authorization: Bearer ${HOTEL_PUBLISHER_TOKEN}`; ispisuje `problems` ako ih Admin Panel vrati.
- Compose `claude-hotel`: `api` (`hotel-api-claude`, `4200:4200` na svim adresama NAS-a, `env_file` `/volume1/ci/hotel/hotel.env`, `CENTRAL_ADMIN_URL=http://192.168.1.199:4100`, `CENTRAL_ADMIN_ALLOW_HTTP=true`, migrira pa sluša, healthcheck `GET /health`), `web` (`hotel-web-claude`, `4201:3000`, `HOTEL_API_URL=http://hotel-api-claude:4200`). Slike `hotel-claude:<sha>` i `hotel-claude:staging`; posle deploy-a ostaju 3 najnovije `<sha>` oznake, samo za `hotel-claude`.
- `hotel.env` dobija `HOTEL_SECRET_KEY` (nasumičan, jednom) i `HOTEL_ROOT_KEYSET` (izlaz `GET http://192.168.1.199:4100/v1/keys`); `DATABASE_URL` pokazuje na `hotel-postgres-claude`.
- [ ] **Step 1:** Test `manifest.spec.ts`: „svaki ključ iz spec tabela §4.1/§4.2 postoji tačno jednom"; „svaki depends_on postoji u modules"; „nema ciklusa"; „hotel.fiscal_rs required_by_profile = legal_entity, entrepreneur"; „SAFE_MODE_ALLOWED i sve @LicensedAction akcije koriste samo module iz manifesta".
- [ ] **Step 2:** `ci.sh` → FAIL, implementacija, `ci.sh` → PASS.
- [ ] **Step 3:** `deploy.sh`: `ci.sh` (prekida na crvenom) → `docker build` → `up -d --remove-orphans --wait` za `claude-hotel` → čišćenje starih oznaka → ispis `docker ps --filter label=com.docker.compose.project=claude-hotel`. Očekivano: `hotel-api-claude` i `hotel-web-claude` healthy, baze netaknute, POS i Admin Panel kontejneri i dalje `Up`.
- [ ] **Step 4 (vlasnik, u Admin Panel UI):** proizvod `hotel` (podrazumevani režim isteka `safe_mode`), servisni token `product_publisher`, objava manifesta (`node scripts/publish-manifest.mjs`), plan sa modulom `hotel.core` i limitima `rooms` i `users` (bez `users` je `POST /users` 403 `limit_exceeded`), pretplata, instalacija i aktivacioni kod. Admin Panel kod se ne menja. Detalji: `docs/contracts/admin-panel.md`.
- [ ] **Step 5:** `scripts/smoke-1a.mjs --api http://192.168.1.199:4200 --email <pravi vlasnik> --property-name "<pravo ime objekta>" --setup-token … --code … --totp-out ~/owner-totp.txt`: status podešavanja → aktivacija → vlasnik (TOTP iz `totpUri`) → potvrda TOTP-a → prijava → tip SMOKE sa 2 jedinice → cenovnik SMOKE i cene za 30 dana → rezervacija → kalendar pokazuje boravak → otkazivanje. Očekivano: svaki korak `OK` ili `SKIP` (već urađeno), exit 0. Nastavljiv: posle neuspeha se pokreće ponovo (aktivacija se preskače; posle završenog podešavanja prijava sa `--totp`/`--totp-file`).
- [ ] **Step 6:** Ručna provera na telefonu i računaru (`http://192.168.1.199:4201`): prijava sa TOTP-om, kalendar, nova rezervacija, premeštanje boravka na drugu jedinicu, poruka „Nema slobodnih jedinica" kad je tip pun. (Aktivaciju je već uradio korak 5; čarobnjak za aktivaciju se proverava samo na posebnoj svežoj instalaciji.)
- [ ] **Step 7:** Commit `Publish the hotel manifest and stage phase 1a on the NAS`.
