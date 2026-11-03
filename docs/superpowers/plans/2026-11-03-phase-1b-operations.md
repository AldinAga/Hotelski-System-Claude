# Faza 1b: operativa recepcije (gosti, check-in/out, folio, poslovni dan) — implementacioni plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recepcija prijavljuje i odjavljuje goste, vodi folio sa zaduženjima i plaćanjima (bez fiskalnog računa), zatvara poslovni dan noćnim auditom, čuva pun pravni profil objekta i šalje email potvrde rezervacija; sve to radi na postojećoj staging bazi sa pravim podacima.

**Architecture:** Novi moduli u `apps/hotel-api` (`guests`, `business-day`, `folio`, `stays`, `legal`, `mail`) nad istim Postgres-om i istim obrascem kao 1a: ručne SQL migracije od `0008`, jedna transakcija po promeni sa auditom u njoj, licenca po akciji. Poslovni dan je red `business_day` čije zaključavanje (deljeno za svako knjiženje, isključivo za zatvaranje) serijalizuje noćni audit prema svakoj promeni novca i statusa boravka. Folio je samo-dodavanje (trigger u bazi), saldo se uvek računa u SQL-u pod zaključanim redom folija, a svaka promena novca nosi ključ idempotentnosti jedinstven u bazi. Email ide kroz outbox u istoj transakciji kao rezervacija; dispečer i automatski noćni audit rade u procesu `hotel-api` (pokreće ih `main.ts`, kao heartbeat licence), jer `hotel-worker` još ne postoji.

**Tech Stack:** isto kao 1a (Node 20, pnpm 9.6.0, NestJS ^10.4.0, drizzle-orm ^0.45.2, pg ^8.12.0, Jest, Next.js ^15.5.24, React 19, Vitest), `@platform/money` 0.2.1, `@platform/licensing` 0.3.0; novo: `nodemailer` ^6.9 (API) i `smtp-server` ^3.13 (samo test). Nove zavisnosti znače `infrastructure/nas/ci.sh --lock` u Tasku 9.

**Spec:** `docs/specs/2026-10-10-hotel-system-design.md` (§4.1 `hotel.core`/`hotel.folio`, §5.1 pravni profil, §5.4 gosti i boravci, §5.5 novac, §5.6 poslovni dan i noćni audit, §7 outbox, §9 siguran režim i bezbednost, §10 testiranje, §13.2 fiskalni režim po profilu). Obim i ograničenja: `.superpowers/sdd/2026-11-03-phase-1b/progress.md` (Rulings 1–3). Granice repoa i NAS-a: `CLAUDE.md`. Format i obrazac: `docs/superpowers/plans/2026-10-26-phase-1a-foundation.md`.

**Grana:** `phase-1b-operations` (iz `2930a51`, Ruling 1). 1a i portal još nisu u `master`-u; ispravke posle koraka 6 iz 1a idu na stariju granu i spajaju se naviše.

**`@platform/fiscal-rs` (provereno 2026-11-03):** ne postoji. `npm view @platform/fiscal-rs --registry http://192.168.1.199:4873/` (sa tokenom iz `~/.npmrc`) vraća `404`; na istom registru postoje `@platform/money` 0.2.1 i `@platform/licensing` 0.2.1/0.3.0. Anonimni `curl` vraća `401` za svaki `@platform/*` paket, pa ne govori ništa. `D:\Claude\Platform Kit\packages` ima samo `licensing` i `money`. Posledica: fiskalizacija u 1c traži zaseban Platform Kit zadatak uz odobrenje korisnika (Ruling 2).

**Obim 1b (Ruling 2):** gosti (nosilac i dodatni gosti po boravku, bez e-Turista polja), check-in/check-out, folio i plaćanja (gotovina, kartica, prenos; bez fiskalnog računa), nefiskalni račun i predračun, poslovni dan i noćni audit (ručni i automatski), pun pravni profil (bez uključivanja fiskalizacije i e-Turiste), email potvrda i otkaz rezervacije, back-to-top u unutrašnjoj aplikaciji. **Van obima (1c):** e-Turista (`ExportProvider`, `eturista_status`, polja dokumenta), fiskalizacija i blokada plaćanja bez fiskalnog računa (§4.2), boravišna taksa, IPS QR, avansni računi, ponovno otvaranje zatvorenog folija, poruke na engleskom.

**Manifest:** 1b ne menja `product/manifest.json`. Moduli su `hotel.core` i `hotel.folio` (oba `core: true`, već u verziji `0.1.0`), a manifest ne nosi akcije. Admin Panel sam dodaje `core: true` module u svaku licencu (`apps/admin-api/src/plans/entitlements.ts`, samo čitanje), pa staging licenca već ima `hotel.folio`; smoke to proverava. Ako neki task ipak mora da menja manifest: veća `version` (`0.2.0`), a objava (`scripts/publish-manifest.mjs`) je korak korisnika, nikad implementera (Ruling 3).

**Taskovi sa novcem ili konkurencijom (pregled sa posebnom pažnjom):** 3, 4, 5, 6, 8. Oznaka **[novac/konkurencija]** u naslovu.

## Global Constraints

Važi sve iz 1a (`docs/superpowers/plans/2026-10-26-phase-1a-foundation.md`, Global Constraints), ponovljeno ukratko:

- Svaka poslovna tabela ima `property_id uuid NOT NULL REFERENCES property(id)`; svaki upit filtrira po `property_id`; strani ključevi na složen ključ `(property_id, id)` kao u `0007`.
- Novac: celobrojne minor jedinice, kolona `bigint`, u kodu `Money` iz `@platform/money` (`fromMinor`, `add`, `subtract`, `negate`, `isZero`); valuta `RSD`. Iz baze se iznos čita kao `::text` i pretvara uz proveru `Number.isSafeInteger` (obrazac `minorFrom` u `reservations.service.ts`).
- Audit svake promene: `AuditService.record` u istoj transakciji.
- Testovi samo na NAS-u (`infrastructure/nas/ci.sh`); bez `pnpm install` na Windows-u; lockfile se pravi na NAS-u (`ci.sh --lock`).
- Na NAS-u samo `claude-hotel` i `claude-hotel-ci`; jednokratni poslovi kroz `docker exec`; nijedan kontejner ne sme sam da se ugasi.
- Tekst za korisnika srpski latinicom; kod, identifikatori i commit poruke engleski.
- Svaki guard, filter i provera dokazuje se brisanjem (test mora pasti, i to iz navedenog razloga; mutacija, test i vraćanje su tri odvojene komande).
- `SAFE_MODE_ALLOWED` je lista u kodu (`safe-mode.ts`); svaka ruta ima `@LicensedAction` ili `@Unlicensed` (`test/licensed-routes.e2e-spec.ts`).

Dodato za 1b:

- **Redosled zaključavanja (proširuje komentar u `inventory.service.ts` i `reservations.service.ts`).** Svaka transakcija uzima zaključavanja ovim redom i nikad unazad:
  0. red otvorenog `business_day` (`FOR SHARE` za check-in, check-out, zaduženje, plaćanje, dokument; `FOR UPDATE` samo za zatvaranje dana);
  1. red `reservation` (`FOR UPDATE`, po `id` kad ih je više);
  2. red `unit`; 3. scope advisory lock; 4. redovi `inventory_day` (postojeći redosled iz 1a);
  5. brojači (`reservation_counter`, `document_counter`);
  6. red `folio` (`FOR UPDATE`, po `stay_id` kad ih je više).
  `book`, `cancel` i `assignUnit` iz 1a ne uzimaju `business_day`; ništa ne sme uzeti `business_day` posle reda rezervacije.
- **Poslovni datum** svakog knjiženja (`folio_line.business_date`, `payment.business_date`) je dan otvorenog `business_day`, pročitan pod zaključavanjem iz tačke 0 u istoj transakciji. Nikad sistemski datum.
- **Folio je samo-dodavanje.** `folio_line` i `payment` se ne menjaju i ne brišu (trigger `BEFORE UPDATE OR DELETE` baca `append_only`); ispravka je nova stavka sa `reverses_line_id` (ili storno plaćanja sa `reverses_payment_id`) i razlogom u auditu. Trigger je na nivou reda, ne `TRUNCATE` (inače `truncate()` u `test/db.ts` pada).
- **Saldo** = zbir `folio_line.amount_minor` − zbir `payment.amount_minor`; računa se SQL-om u transakciji pod zaključanim redom folija i nikad se ne čuva u koloni. Zatvoren folio (`status = 'closed'`) ima saldo 0 i ne prima nove stavke ni plaćanja (`409 folio_closed`).
- **Idempotentnost u bazi, ne samo u kodu:** jedna stavka smeštaja po noći i foliju (`folio_line_night`), jedan storno po stavci i po plaćanju (`UNIQUE reverses_*`), ključ zahteva jedinstven po objektu (`UNIQUE (property_id, idempotency_key)`), outbox ključ jedinstven po objektu. Isti ključ sa istim telom vraća prvi rezultat (`200`), sa drugačijim telom `409 idempotency_key_reused`.
- **`reservation.version`** povećavaju samo promene statusa i dodele: book, cancel, assign-unit, check-in, check-out, no-show. Zaduženja, plaćanja, dokumenti i noćna knjiženja ga ne menjaju (zaključavaju folio), da noćni audit ne bi poništio svaku otvorenu stranicu rezervacije.
- **GET nikad ne piše:** `business_day` i `folio` nastaju samo u transakcijama koje menjaju podatke (`BusinessDayService.lockOpen`, `FolioService.ensureFolio`); GET za objekat bez reda vraća izračunat prikaz.
- **Migracije prolaze na postojećoj bazi (Ruling 3):** samo dodavanje (`ADD COLUMN` nullable ili sa `DEFAULT`, nove tabele, zamena `CHECK`-a širim), backfill u istoj migraciji, bez pretpostavke prazne baze. Svaka migracija 1b dobija proveru u `test/upgrade.e2e-spec.ts` (baza dovedena do `0007`, napunjena podacima oblika 1a, pa migrirana do kraja).
- **Bez fiskalnih i e-Turista poziva i polja.** `payment.fiscal_document_id` ostaje `NULL`; svaki dokument nosi oznaku „Ovo nije fiskalni račun". Poreske stope i oznake nisu u kodu (spec §13.2): dolaze iz podešavanja objekta.
- **Lični podaci:** JMBG fizičkog lica se u odgovorima i auditu prikazuje maskiran (`•••••••••1234`); e-adrese i telefoni gostiju ne idu u log aplikacije.
- **Vreme aplikacije je `CLOCK`** (`common/clock.ts`): svaki trenutak koji se poredi sa „sada" (outbox rokovi i lease, automatsko zatvaranje, `closed_at`, `closedAt` u izveštaju) upisuje se iz `CLOCK`, ne iz SQL `now()`/`DEFAULT now()`; testovi pomeraju sat, a baza ne.
- **Pozadinski poslovi** (`OutboxDispatcher`, `NightAuditScheduler`) žive u procesu `hotel-api`, pokreće ih samo `main.ts` posle migracija (kao `LicenceService.start()`); testovi ih ne pokreću, nego zovu `runOnce()`.

## Review Focus

1. **Noćni audit dvaput ili paralelno sa check-outom ili plaćanjem** → svaka noć se knjiži tačno jednom; drugo zatvaranje vraća sačuvan izveštaj; plaćanje koje čeka zatvaranje dobija sledeći poslovni datum; saldo ostaje tačan. (Task 6: „dva paralelna zatvaranja", „plaćanje koje čeka zatvaranje")
2. **Check-out sa otvorenim saldom ili sa plaćanjem u letu** → `409 folio_balance_open` sa iznosom i ništa se ne menja; zatvoren folio nikad nema saldo ≠ 0; plaćanje posle zatvaranja dobija `409 folio_closed`. (Task 5: „plaćanje u trci sa check-outom")
3. **Dvostruki klik ili ponovljen zahtev za plaćanje** → jedno plaćanje; isti ključ sa drugim iznosom → `409 idempotency_key_reused`. (Task 4: „isti ključ dvaput")
4. **Poslovni datum zaostaje za kalendarom** (dan nije zatvoren posle ponoći; staging posle deploy-a) → check-in gosta koji stiže „danas" daje `409 check_in_wrong_day` sa oba datuma, a ekran kaže da prvo treba zatvoriti dan; rezervacija za dolazak „juče" se ne pravi (`arrival_in_past`, 1a pravilo po kalendaru). Obrnuto, posle večernjeg zatvaranja dana rezervacija za „danas" (pre poslovnog dana) daje `422 arrival_before_business_date`, umesto da nastane boravak koji se ne može prijaviti. (Task 5 i Task 12)
5. **Migracija na staging bazi sa podacima 1a** (boravci bez gostiju i folija, `expected` boravci sa prošlim dolaskom, `legal_profile` bez novih polja) → migracije prolaze, backfill popunjava gosta nosioca i otvoren poslovni dan, a prvo zatvaranje dana te stare boravke prevodi u no-show i navodi ih u izveštaju. (Task 2, 3, 6 i 7: `upgrade.e2e-spec.ts`; Task 6: „stari expected boravak")

---

## Struktura fajlova

```
apps/hotel-api/src/
  db/migrations/0008_guests.sql             stay_guest, guest.note, backfill nosioca
  db/migrations/0009_business_day.sql       business_day, property_settings, stay: no_show i vremena prijave
  db/migrations/0010_folio.sql              folio, folio_line, payment, trigger append_only
  db/migrations/0011_legal_profile.sql      pun pravni profil, fiscal_mode iz kind
  db/migrations/0012_documents.sql          folio_document, document_counter
  db/migrations/0013_outbox.sql             outbox_message, outbox_attempt
  common/idempotency.ts                     ključ zahteva i heš tela
  guests/        guests.service.ts, guests.controller.ts, guests.module.ts
  business-day/  business-day.service.ts, settings.service.ts, night-audit.service.ts,
                 night-audit.scheduler.ts, business-day.controller.ts, business-day.module.ts
  folio/         folio.service.ts, folio.controller.ts, documents.service.ts, folio.module.ts
  stays/         stay-lifecycle.service.ts, stay-lifecycle.controller.ts, stays.module.ts
  legal/         legal-ids.ts, legal-profile.service.ts, legal-profile.controller.ts, legal.module.ts
  mail/          mail-transport.ts, smtp.transport.ts, templates.ts, outbox.service.ts,
                 outbox.dispatcher.ts, messages.controller.ts, mail.module.ts
apps/hotel-api/test/
  front-desk.ts                             zajednički pomoćnik za e2e testove 1b
  upgrade.ts, upgrade.e2e-spec.ts           baza oblika 1a → migracije 1b
  guests / business-day / folio / stays / night-audit / documents / legal-profile / outbox .e2e-spec.ts
  fake-smtp.ts
apps/hotel-web/src/
  components/back-to-top.tsx (izmena), app-shell.tsx (izmena)
  components/stay-actions.tsx, stay-guests.tsx, folio-view.tsx, document-view.tsx
  app/folio/[stayId]/page.tsx, app/dokumenti/[id]/page.tsx, app/poslovni-dan/page.tsx,
  app/podesavanja/pravni-profil/page.tsx, app/podesavanja/poslovanje/page.tsx
  lib/idempotency.ts, lib/types.ts (izmena), lib/messages.ts (izmena)
scripts/smoke-1b.mjs
```

Moduli se dodaju u `imports` `AppModule` u redosledu: `GuestsModule`, `BusinessDayModule`, `FolioModule`, `StaysModule`, `LegalModule`, `MailModule`.

---

### Task 1: Back-to-top u unutrašnjoj aplikaciji

Pravilo vlasnika (globalni `CLAUDE.md`): svaka stranica ima „Back to top", fiksirano dole desno uz safe-area, pojavljuje se posle prvog ekrana, `aria-label` na jeziku stranice, vidljiv fokus, poštuje `prefers-reduced-motion`, čitljivo u svetloj i tamnoj temi. Komponenta postoji, ali je samo u ulaznom portalu i ima tri propusta za unutrašnju aplikaciju: (a) naslovi `<h1>` unutrašnjih stranica nemaju `tabIndex={-1}`, pa `focus()` ne radi; (b) koristi `--p-*` tokene portala koji u tamnom režimu OS-a postaju tamni, a unutrašnja aplikacija je samo svetla; (c) stil fokusa postoji samo pod `.portal`.

**Files:**
- Modify: `apps/hotel-web/src/components/back-to-top.tsx`, `apps/hotel-web/src/components/app-shell.tsx`, `apps/hotel-web/src/app/globals.css`
- Create: `apps/hotel-web/src/components/back-to-top.test.tsx`

**Interfaces:**
- Produces: `BackToTop({ label = 'Nazad na vrh', variant = 'portal' }: { label?: string; variant?: 'portal' | 'app' })`; `variant="app"` dodaje klasu `back-to-top--app`. Pre fokusiranja, ako prvi `main h1` (pa `h1`) nema atribut `tabindex`, komponenta mu postavlja `tabindex="-1"`. `AppShell` renderuje `<BackToTop variant="app" />` posle `{children}`.
- CSS: `.back-to-top--app` koristi samo tokene aplikacije (`--surface`, `--text`, `--line`, `--accent`), bez `--p-*` i bez `backdrop-filter`; `.back-to-top:focus-visible` (oba varijanta) `outline: 3px solid` (`--accent` u aplikaciji, `--p-focus` ili postojeći prsten u portalu), `outline-offset: 2px`. Postojeća pravila za `prefers-reduced-motion` i `forced-colors` važe i za varijantu.

- [ ] **Step 1: Napiši testove koji padaju** (`back-to-top.test.tsx`)

```tsx
import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './app-shell';
import { BackToTop } from './back-to-top';

function setScroll(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
  act(() => {
    window.dispatchEvent(new Event('scroll'));
  });
}

function mockReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: reduce && q.includes('prefers-reduced-motion'),
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('BackToTop', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    setScroll(0);
  });
  afterEach(() => vi.restoreAllMocks());

  it('stays hidden and out of the tab order until the page scrolls past the first screen', () => {
    render(<BackToTop variant="app" />);
    const button = screen.getByRole('button', { name: 'Nazad na vrh', hidden: true });
    expect(button).toHaveAttribute('tabindex', '-1');
    expect(button).toHaveAttribute('aria-hidden', 'true');
    setScroll(800);
    expect(button).toHaveAttribute('tabindex', '-1');
    setScroll(801);
    expect(button).toHaveAttribute('tabindex', '0');
    expect(button).not.toHaveAttribute('aria-hidden');
    expect(button).toHaveClass('back-to-top', 'back-to-top--app', 'is-visible');
  });

  it('scrolls smoothly and moves focus to the page heading, even one without tabIndex', () => {
    mockReducedMotion(false);
    render(
      <main>
        <h1>Kalendar</h1>
        <BackToTop variant="app" />
      </main>,
    );
    setScroll(2000);
    fireEvent.click(screen.getByRole('button', { name: 'Nazad na vrh' }));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Kalendar' }));
  });

  it('with prefers-reduced-motion it jumps without animation', () => {
    mockReducedMotion(true);
    render(<BackToTop variant="app" />);
    setScroll(2000);
    fireEvent.click(screen.getByRole('button', { name: 'Nazad na vrh' }));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });

  it('every signed-in screen gets it through AppShell', () => {
    render(
      <AppShell>
        <h1>Jedinice</h1>
      </AppShell>,
    );
    expect(screen.getByRole('button', { name: 'Nazad na vrh', hidden: true })).toHaveClass('back-to-top--app');
  });

  it('the app variant uses only app tokens and has a visible focus ring', () => {
    const css = readFileSync(join(__dirname, '../app/globals.css'), 'utf8');
    const app = css.match(/\.back-to-top--app\s*\{[^}]*\}/g) ?? [];
    expect(app.length).toBeGreaterThanOrEqual(1);
    for (const block of app) {
      expect(block).not.toMatch(/--p-/);
      expect(block).toMatch(/var\(--surface\)/);
    }
    expect(css).toMatch(/\.back-to-top:focus-visible\s*\{[^}]*outline:\s*3px solid/);
  });
});
```

`AppShell` sadrži `LicenceBanner` i `SignOutButton` koji zovu API: test koristi `src/test/fetch-mock.ts` kao ostali testovi `AppShell`-a (`app-shell.test.tsx`).

- [ ] **Step 2:** `infrastructure/nas/ci.sh` → FAIL (`variant` ne postoji, `AppShell` nema dugme, naslov ne dobija fokus).
- [ ] **Step 3:** Implementacija po Interfaces bloku.
- [ ] **Step 4:** `ci.sh` → PASS. Proba brisanjem: ukloni postavljanje `tabindex` na naslov → test „moves focus to the page heading" mora pasti (`activeElement` je `body`); vrati.
- [ ] **Step 5 (ručno, na stagingu posle deploy-a iz Taska 14, jer se na računaru ništa ne pokreće; telefon 375 px i računar):** kalendar skrolovan ispod prvog ekrana → dugme dole desno, ne preklapa iPhone home indikator, Tab do njega pokazuje prsten, klik vraća na vrh i fokus na naslov; u tamnom režimu OS-a dugme ostaje svetlo i čitljivo na svetloj aplikaciji. Rezultat se upisuje u izveštaj Taska 14.
- [ ] **Step 6:** Commit `Add the back-to-top button to every signed-in screen`.

---

### Task 2: Gosti po boravku, zajednički test pomoćnik i provera nadogradnje baze

**Files:**
- Create: `apps/hotel-api/src/db/migrations/0008_guests.sql`
- Create: `apps/hotel-api/src/guests/{guests.service.ts,guests.controller.ts,guests.module.ts}`
- Create: `apps/hotel-api/test/{front-desk.ts,upgrade.ts,upgrade.e2e-spec.ts,guests.e2e-spec.ts}`
- Modify: `apps/hotel-api/src/reservations/reservations.service.ts` (book upisuje nosioca u `stay_guest` za svaki boravak; `get` vraća goste boravka), `apps/hotel-api/src/app.module.ts`, `apps/hotel-api/src/licensing/safe-mode.ts` (`guest.view`)

**Interfaces:**
- `0008_guests.sql`:
  ```sql
  ALTER TABLE guest ADD COLUMN note text;
  CREATE TABLE stay_guest (
    property_id uuid NOT NULL REFERENCES property (id),
    stay_id uuid NOT NULL,
    guest_id uuid NOT NULL,
    is_primary boolean NOT NULL DEFAULT false,
    added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (stay_id, guest_id),
    FOREIGN KEY (property_id, stay_id) REFERENCES stay (property_id, id),
    FOREIGN KEY (property_id, guest_id) REFERENCES guest (property_id, id)
  );
  CREATE UNIQUE INDEX stay_guest_one_primary ON stay_guest (stay_id) WHERE is_primary;
  -- Backfill: the holder is the primary guest of every stay that is not cancelled.
  INSERT INTO stay_guest (property_id, stay_id, guest_id, is_primary)
  SELECT s.property_id, s.id, r.holder_guest_id, true
    FROM stay s JOIN reservation r ON r.id = s.reservation_id AND r.property_id = s.property_id
   WHERE s.status <> 'cancelled'
  ON CONFLICT DO NOTHING;
  ```
  E-Turista polja (pol, datum rođenja, državljanstvo, dokument, adresa, `eturista_status`) dolaze u 1c.
- `GuestsService`:
  - `search(q: string): Promise<GuestView[]>` — ime, prezime, e-adresa, telefon (`ILIKE`, isti escape kao `ReservationsService.list`), najviše 50.
  - `create(input: GuestInput, actor): Promise<GuestView>`; `update(id, input, actor)`; `GuestInput = { firstName: string; lastName: string; email?: string | null; phone?: string | null; language?: string; note?: string | null }` (ista pravila polja kao nosilac u `parseBookInput`, `note` do 2000 znakova).
  - `addToStay(stayId, body: { guestId?: string; guest?: GuestInput }, actor)` → zaključava red rezervacije boravka (`FOR UPDATE`), boravak mora biti `expected` ili `in_house` (`409 stay_not_editable`), broj gostiju posle dodavanja ≤ `adults + children` (`422 too_many_guests { limit }`), dupli gost `409 guest_already_on_stay`.
  - `removeFromStay(stayId, guestId, actor)` — primarnog ne uklanja (`409 primary_guest_required`); `setPrimary(stayId, guestId, actor)` (jedna transakcija: skine stari, postavi novi).
  - `ensurePrimary(tx, propertyId, stayId): Promise<void>` — ako boravak nema primarnog gosta, dodaje nosioca rezervacije kao primarnog (koristi check-in u Tasku 5).
  - `GuestView = { id; firstName; lastName; email: string | null; phone: string | null; language: string; note: string | null }`; `StayView` iz `ReservationsService.get` dobija `guests: Array<GuestView & { isPrimary: boolean }>`.
- API (`@Roles('owner','manager','receptionist')`): `GET /guests?q` (`hotel.core`, `guest.view`), `POST /guests` i `PATCH /guests/:id` (`guest.manage`), `POST /stays/:id/guests`, `DELETE /stays/:id/guests/:guestId`, `POST /stays/:id/guests/:guestId/primary` (`guest.manage`). Izmene gostiju ne menjaju `reservation.version` (nisu promena statusa).
- `test/front-desk.ts` (koriste ga svi e2e testovi 1b):
  ```ts
  export const NOW = new Date('2026-11-02T08:00:00Z'); // 09:00 Beograd; "danas" objekta je 2026-11-02
  export const DAY_MS = 86_400_000;
  export interface FrontDesk {
    ta: TestApp;
    app: INestApplication;
    fake: FakeCentralAdmin;
    owner: string; manager: string; receptionist: string; housekeeping: string; // kolačići sesije
    managerId: string;
    setNow(at: Date): void;               // sat aplikacije (CLOCK)
    shiftLicence(ms: number): void;       // sat licence, za siguran režim
    reset(licence?: Partial<LicensePayload>): Promise<void>;
    // truncate, NOW, aktivacija sa modules ['hotel.core','hotel.folio'], limits { rooms: 20, users: 10 },
    // expiry_mode 'safe_mode', zatim spoj sa `licence`; seed owner/manager/receptionist/housekeeping
    get(path: string, cookie?: string): request.Test;             // podrazumevano receptionist
    post(path: string, body?: object, cookie?: string): request.Test;
    put(path: string, body?: object, cookie?: string): request.Test;  // podrazumevano manager
    patch(path: string, body?: object, cookie?: string): request.Test; // podrazumevano manager
    del(path: string, cookie?: string): request.Test;
    pricedType(code: string, units: number, priceMinor?: number): Promise<{ typeId: string; unitIds: string[]; planId: string }>;
    // plan 'BAR' (jedan po reset-u), cena za 2026-11-01..2028-03-01, podrazumevano 1_000_000 (10.000,00 RSD)
    bookStay(t: { typeId: string; planId: string; unitId?: string }, arrival: string, departure: string,
             extra?: { holder?: object; adults?: number; children?: number }): Promise<{ reservationId: string; stayId: string; version: number }>;
    sql<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
    close(): Promise<void>;
  }
  export async function startFrontDesk(): Promise<FrontDesk>;
  ```
  Telo pomoćnika se piše po obrascu postojećih helpera u `test/reservations.e2e-spec.ts` (`activate`, `createType`, `createUnit`, `price`, `book`); taj spec se ne prepravlja. Podrazumevani nosilac u `bookStay`: `{ firstName: 'Petar', lastName: 'Petrović', email: 'petar@example.com' }`, `adults: 2`, `source: 'front_desk'`. Kasniji taskovi dopunjuju pomoćnik: Task 5 `inHouse(t, arrival, departure)` (book na jedinicu + check-in, vraća novu verziju), Task 9 `mail: FakeMailTransport` i `dispatcher: OutboxDispatcher` (uz novu opciju `mail?: MailTransport` u `TestAppOptions`, `test/app.ts`).
- `test/upgrade.ts`:
  ```ts
  /** A scratch database migrated with 0001..`upTo` only (copies those files to a temp dir and calls migrate(pool, dir)). */
  export async function databaseAt(upTo: string, name: string): Promise<Pool>;
  /** Rows shaped like phase 1a data: property, legal_profile (legal_entity, no new fields), a unit type with 2 units,
   *  a plan, a confirmed reservation with an expected stay arriving 2026-10-30 (past) on unit 1, a confirmed one arriving
   *  2026-11-05, a cancelled one; inventory_day sold rows as book would leave them. Returns their ids. */
  export async function seedPhase1a(pool: Pool): Promise<Phase1aSeed>;
  ```
  `upgrade.e2e-spec.ts` ima jedan `describe` po migraciji 1b; svaki task koji dodaje migraciju dodaje svoj `it` (baza `hotel_upgrade_${JEST_WORKER_ID}`, `createScratchPool` iz `test/db.ts`).

- [ ] **Step 1: Napiši testove koji padaju**

`upgrade.e2e-spec.ts` (osnova i `0008`):

```ts
import type { Pool } from 'pg';
import { migrate } from '../src/db/migrate';
import { databaseAt, seedPhase1a, type Phase1aSeed } from './upgrade';

describe('migrations 0008+ on a database holding phase 1a data', () => {
  let pool: Pool;
  let seed: Phase1aSeed;

  beforeAll(async () => {
    pool = await databaseAt('0007', `hotel_upgrade_${process.env.JEST_WORKER_ID ?? '1'}`);
    seed = await seedPhase1a(pool);
    const applied = await migrate(pool);
    expect(applied[0]).toBe('0008_guests.sql');
  });
  afterAll(() => pool.end());

  it('0008: every stay that is not cancelled has its holder as the one primary guest', async () => {
    const { rows } = await pool.query<{ stay_id: string; guest_id: string; is_primary: boolean }>(
      'SELECT stay_id, guest_id, is_primary FROM stay_guest ORDER BY stay_id',
    );
    expect(rows).toEqual(
      [
        { stay_id: seed.pastStayId, guest_id: seed.pastHolderId, is_primary: true },
        { stay_id: seed.futureStayId, guest_id: seed.futureHolderId, is_primary: true },
      ].sort((a, b) => a.stay_id.localeCompare(b.stay_id)),
    );
    expect(seed.cancelledStayId).toBeDefined();
  });
});
```

`guests.e2e-spec.ts` (imena testova; svaki proverava i audit red gde piše):
- „book upisuje nosioca kao primarnog gosta svakog boravka; GET /reservations/:id vraća goste boravka";
- „dodavanje novog gosta i postojećeg gosta (guestId) na boravak; audit `stay.guest_add`";
- „treći gost na boravku za 2 odrasle osobe: 422 too_many_guests sa limit 2, ništa nije upisano";
- „isti gost dvaput: 409 guest_already_on_stay";
- „uklanjanje primarnog: 409 primary_guest_required; posle setPrimary na drugog gosta uklanjanje starog prolazi";
- „gost na otkazanom boravku: 409 stay_not_editable";
- „pretraga po delu prezimena i po e-adresi; `%` u upitu se traži doslovno";
- „housekeeping: 403 forbidden_role na GET /guests";
- „u sigurnom režimu GET /guests radi, POST /guests je 403 safe_mode_blocked".

- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija. Dodaj `guest.view` u `SAFE_MODE_ALLOWED`. Mutaciona provera granice: `too_many_guests` testira `adults + children` granicu tačno (2 prolazi, 3 pada).
- [ ] **Step 4:** `ci.sh` → PASS. Proba brisanjem: (a) ukloni `WHERE s.status <> 'cancelled'` iz backfill-a → test `0008` mora pasti (otkazan boravak dobija gosta); (b) ukloni proveru broja gostiju → „too_many_guests" mora pasti; vrati oba.
- [ ] **Step 5:** Commit `Record the guests of each stay and test migrations against phase 1a data`.

---

### Task 3: Poslovni dan, podešavanja objekta i proširen siguran režim [novac/konkurencija]

**Files:**
- Create: `apps/hotel-api/src/db/migrations/0009_business_day.sql`
- Create: `apps/hotel-api/src/business-day/{business-day.service.ts,settings.service.ts,business-day.controller.ts,business-day.module.ts}`
- Create: `apps/hotel-api/test/business-day.e2e-spec.ts`
- Modify: `apps/hotel-api/src/licensing/safe-mode.ts`, `apps/hotel-api/src/inventory/inventory.service.ts` i `apps/hotel-api/src/reservations/reservations.service.ts` (samo komentar o redosledu zaključavanja, tačka 0), `test/upgrade.e2e-spec.ts`

**Interfaces:**
- `0009_business_day.sql`:
  ```sql
  -- One open business day per property; 'closing' is reserved by spec 5.6 but never committed:
  -- the close runs in one transaction.
  CREATE TABLE business_day (
    property_id uuid NOT NULL REFERENCES property (id),
    day date NOT NULL,
    status text NOT NULL CHECK (status IN ('open', 'closing', 'closed')),
    opened_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    closed_by uuid REFERENCES app_user (id),
    close_mode text CHECK (close_mode IN ('manual', 'auto')),
    report jsonb,
    last_auto_error jsonb,
    PRIMARY KEY (property_id, day),
    CHECK ((status = 'closed') = (closed_at IS NOT NULL AND report IS NOT NULL AND close_mode IS NOT NULL))
  );
  CREATE UNIQUE INDEX business_day_one_open ON business_day (property_id) WHERE status <> 'closed';
  INSERT INTO business_day (property_id, day, status)
  SELECT id, (now() AT TIME ZONE timezone)::date, 'open' FROM property
  ON CONFLICT DO NOTHING;

  CREATE TABLE property_settings (
    property_id uuid PRIMARY KEY REFERENCES property (id),
    auto_close_time time,                 -- null: no automatic night audit
    no_show_charge text NOT NULL DEFAULT 'none' CHECK (no_show_charge IN ('none', 'first_night')),
    accommodation_vat_bp int CHECK (accommodation_vat_bp BETWEEN 0 AND 10000), -- null: not shown
    vat_rates_bp int[] NOT NULL DEFAULT '{}',  -- rates a manual charge may carry
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  INSERT INTO property_settings (property_id) SELECT id FROM property ON CONFLICT DO NOTHING;

  ALTER TABLE stay DROP CONSTRAINT stay_status_check;
  ALTER TABLE stay ADD CONSTRAINT stay_status_check
    CHECK (status IN ('expected', 'in_house', 'checked_out', 'cancelled', 'no_show'));
  ALTER TABLE stay
    ADD COLUMN checked_in_at timestamptz,
    ADD COLUMN checked_in_by uuid REFERENCES app_user (id),
    ADD COLUMN checked_in_business_date date,
    ADD COLUMN checked_out_at timestamptz,
    ADD COLUMN checked_out_by uuid REFERENCES app_user (id),
    ADD COLUMN checked_out_business_date date;
  ```
  `checked_*_business_date` se upisuje pod deljenim zaključavanjem dana (Task 5) i jedini je izvor za brojeve dolazaka i odlazaka u izveštaju noćnog audita (`departure` se menja pri ranom odlasku, a vremena su sistemska).
  Ime `stay_status_check` je Postgres-ovo podrazumevano ime za `CHECK` kolone iz `0007`; implementer ga proverava na test bazi (`SELECT conname FROM pg_constraint WHERE conrelid = 'stay'::regclass`) pre pisanja migracije. Exclusion constraint iz `0007` već isključuje `no_show` (uslov je `status IN ('expected','in_house')`), pa no-show sam oslobađa jedinicu.
- `BusinessDayService`:
  - `lockOpen(tx: Tx, propertyId: string, mode: 'share' | 'update'): Promise<string>` — vraća otvoreni dan (`YYYY-MM-DD`) i drži `SELECT … FOR SHARE|FOR UPDATE` nad njegovim redom. Ako reda nema (sveža instalacija), prvo `INSERT … (day = danas objekta, 'open') ON CONFLICT DO NOTHING`, pa čitanje sa zaključavanjem. Zove se samo iz transakcija koje pišu. Pod READ COMMITTED, `SELECT … FOR UPDATE` koji je čekao na zatvaranje dana ne vidi red novog dana (snimak naredbe je stariji) i vraća prazno: zato je telo petlja „SELECT sa zaključavanjem → ako je prazno, INSERT … ON CONFLICT DO NOTHING → ponovo SELECT (nova naredba)", najviše 3 kruga, inače `Error`. Test „two closes in parallel" (Task 6) prolazi baš kroz ovaj put.
  - `view(): Promise<BusinessDayView>` — samo čita; bez reda vraća `started: false` i `day = today`.
  - `BusinessDayView = { day: string; today: string; started: boolean; lagDays: number; lastClosed: { day: string; closedAt: string; mode: 'manual'|'auto' } | null; lastAutoError: { at: string; code: string; details: unknown } | null }` (`lagDays` = `today − day`, za upozorenje u UI).
- `SettingsService`: `get(): Promise<PropertySettings>` (bez reda: podrazumevane vrednosti, bez upisa); `update(input, actor)` (upsert; polja kojih nema u telu zadržavaju vrednost, `null` briše; audit `settings.update`). `PropertySettings = { autoCloseTime: string | null /* 'HH:MM' */; noShowCharge: 'none' | 'first_night'; accommodationVatBp: number | null; vatRatesBp: number[] }`. Validacija: vreme `^([01]\d|2[0-3]):[0-5]\d$`, stope cele `0..10000`, najviše 5 stopa, bez duplikata.
- API: `GET /business-day` (`hotel.folio`, `business_day.view`, uloge owner/manager/receptionist), `GET /settings/business` (`settings.view`, owner/manager), `PUT /settings/business` (`settings.manage`, owner/manager). Zatvaranje (`POST /business-day/close`) i izveštaji dolaze u Tasku 6.
- `SAFE_MODE_ALLOWED` posle ovog taska (dodaci 1b, sa komentarom spec §9):
  `guest.view`, `stay.check_out`, `folio.view`, `folio.pay`, `folio.document`, `business_day.view`, `business_day.close`, `settings.view`, `legal_profile.view`, `message.view`.
  Ne ulaze: `stay.check_in`, `guest.manage`, `folio.charge`, `folio.correct`, `settings.manage`, `legal_profile.manage`, `message.resend`. `business_day.close` je u listi jer bez zatvaranja dana noćenja gostiju u kući prestaju da se knjiže i folio se ne može izmiriti (otvoreno pitanje 1 na kraju plana).

- [ ] **Step 1: Napiši testove koji padaju** (`business-day.e2e-spec.ts`)

```ts
import { BusinessDayService } from '../src/business-day/business-day.service';
import { PropertyContext } from '../src/common/property-context';
import { startFrontDesk, type FrontDesk } from './front-desk';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('business day (e2e)', () => {
  let fd: FrontDesk;
  let svc: BusinessDayService;
  let pid: string;

  beforeAll(async () => {
    fd = await startFrontDesk();
  });
  beforeEach(async () => {
    await fd.reset();
    svc = fd.app.get(BusinessDayService);
    pid = await fd.app.get(PropertyContext).id();
  });
  afterAll(() => fd.close());

  const open = (mode: 'share' | 'update') => fd.ta.testDb.db.transaction((tx) => svc.lockOpen(tx, pid, mode));

  it('GET /business-day without a row answers today and writes nothing', async () => {
    const res = await fd.get('/business-day');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ day: '2026-11-02', today: '2026-11-02', started: false, lagDays: 0 });
    expect(await fd.sql('SELECT 1 FROM business_day')).toHaveLength(0);
  });

  it('ten concurrent first writes open today exactly once', async () => {
    const days = await Promise.all(Array.from({ length: 10 }, () => open('share')));
    expect(new Set(days)).toEqual(new Set(['2026-11-02']));
    expect(await fd.sql(`SELECT day::text AS day, status FROM business_day`)).toEqual([
      { day: '2026-11-02', status: 'open' },
    ]);
  });

  it('an update lock waits for a share lock on the same open day', async () => {
    await open('share'); // the row exists and is committed: the wait below is the row lock, not the insert
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let taken!: () => void;
    const sharedTaken = new Promise<void>((r) => (taken = r));
    const a = fd.ta.testDb.db.transaction(async (tx) => {
      await svc.lockOpen(tx, pid, 'share');
      taken();
      await held;
    });
    await sharedTaken;
    let bDone = false;
    const b = fd.ta.testDb.db.transaction(async (tx) => {
      await svc.lockOpen(tx, pid, 'update');
      bDone = true;
    });
    await delay(300);
    expect(bDone).toBe(false);
    release();
    await Promise.all([a, b]);
    expect(bDone).toBe(true);
  });

  it('two share locks do not wait for each other', async () => {
    await open('share');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let taken!: () => void;
    const sharedTaken = new Promise<void>((r) => (taken = r));
    const a = fd.ta.testDb.db.transaction(async (tx) => {
      await svc.lockOpen(tx, pid, 'share');
      taken();
      await held;
    });
    await sharedTaken;
    const started = Date.now();
    await open('share');
    expect(Date.now() - started).toBeLessThan(250);
    release();
    await a;
  });

  it('settings: defaults without a row; PUT stores them; a bad time or rate is 422 naming the field', async () => {
    expect((await fd.get('/settings/business', fd.manager)).body).toEqual({
      autoCloseTime: null,
      noShowCharge: 'none',
      accommodationVatBp: null,
      vatRatesBp: [],
    });
    const ok = await fd.put('/settings/business', {
      autoCloseTime: '03:30',
      noShowCharge: 'first_night',
      accommodationVatBp: 1000,
      vatRatesBp: [0, 1000, 2000],
    });
    expect(ok.status).toBe(200);
    expect((await fd.get('/settings/business', fd.manager)).body.autoCloseTime).toBe('03:30');
    for (const [field, value] of [
      ['autoCloseTime', '24:00'],
      ['accommodationVatBp', 10001],
      ['vatRatesBp', [1000, 1000]],
    ] as const) {
      const res = await fd.put('/settings/business', { [field]: value });
      expect(res.status).toBe(422);
      expect(res.body.details).toEqual({ field });
    }
  });

  it('a receptionist cannot change settings; in safe mode GET works and PUT is safe_mode_blocked', async () => {
    expect((await fd.put('/settings/business', { noShowCharge: 'none' }, fd.receptionist)).body.code).toBe('forbidden_role');
    fd.shiftLicence(400 * 86_400_000);
    expect((await fd.get('/business-day')).status).toBe(200);
    const res = await fd.put('/settings/business', { noShowCharge: 'none' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('safe_mode_blocked');
  });
});
```

`upgrade.e2e-spec.ts` dobija `it('0009: …')`: postoji tačno jedan `open` red za objekat, sa danom = lokalni datum objekta u trenutku migracije (oracle: `SELECT (now() AT TIME ZONE 'Europe/Belgrade')::date` u testu, ne iz servisa); `property_settings` red postoji; `UPDATE stay SET status = 'no_show'` na prošlom boravku prolazi, a `status = 'gone'` pada sa `stay_status_check`.

- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija; `PropertyContext.reset()` u `reset()` testa već postoji, servis ne kešira dan.
- [ ] **Step 4:** `ci.sh` → PASS. Proba brisanjem: (a) ukloni `FOR SHARE` iz `lockOpen('share')` → „an update lock waits" mora pasti (`bDone` je `true` posle 300 ms); (b) ukloni `ON CONFLICT DO NOTHING` → „ten concurrent first writes" mora pasti; vrati oba.
- [ ] **Step 5:** Commit `Add the business day, property settings and the 1b safe-mode actions`.

---

### Task 4: Folio, zaduženja i plaćanja [novac/konkurencija]

**Files:**
- Create: `apps/hotel-api/src/db/migrations/0010_folio.sql`
- Create: `apps/hotel-api/src/common/idempotency.ts`
- Create: `apps/hotel-api/src/folio/{folio.service.ts,folio.controller.ts,folio.module.ts}`
- Create: `apps/hotel-api/test/folio.e2e-spec.ts`
- Modify: `test/upgrade.e2e-spec.ts`

**Interfaces:**
- `0010_folio.sql`:
  ```sql
  CREATE TABLE folio (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id uuid NOT NULL REFERENCES property (id),
    stay_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    UNIQUE (property_id, stay_id),
    UNIQUE (property_id, id),
    FOREIGN KEY (property_id, stay_id) REFERENCES stay (property_id, id),
    FOREIGN KEY (property_id, reservation_id) REFERENCES reservation (property_id, id),
    CHECK ((status = 'closed') = (closed_at IS NOT NULL))
  );
  CREATE TABLE folio_line (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id uuid NOT NULL REFERENCES property (id),
    folio_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('accommodation','tourist_tax','fee','pos','service','deposit','correction')),
    description text NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
    vat_rate_bp int CHECK (vat_rate_bp BETWEEN 0 AND 10000),
    business_date date NOT NULL,
    night date,
    source_type text NOT NULL CHECK (source_type IN ('night_audit','check_out','no_show','manual','reversal')),
    reverses_line_id uuid UNIQUE REFERENCES folio_line (id),
    reason text,
    idempotency_key text,
    request_hash text,
    created_by uuid REFERENCES app_user (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (property_id, folio_id) REFERENCES folio (property_id, id),
    CHECK ((kind = 'correction') = (reverses_line_id IS NOT NULL)),
    CHECK ((kind = 'accommodation') = (night IS NOT NULL)),
    CHECK ((idempotency_key IS NULL) = (request_hash IS NULL))
  );
  CREATE UNIQUE INDEX folio_line_night ON folio_line (folio_id, night) WHERE kind = 'accommodation';
  CREATE UNIQUE INDEX folio_line_key ON folio_line (property_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX folio_line_folio_idx ON folio_line (folio_id);
  CREATE INDEX folio_line_business_date_idx ON folio_line (property_id, business_date);

  CREATE TABLE payment (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id uuid NOT NULL REFERENCES property (id),
    folio_id uuid NOT NULL,
    method text NOT NULL CHECK (method IN ('cash','card','card_link','ips_qr','transfer','advance')),
    amount_minor bigint NOT NULL CHECK (amount_minor <> 0),  -- negative: refund or void
    business_date date NOT NULL,
    reference text,
    fiscal_document_id text,  -- phase 1c; always null in 1b
    reverses_payment_id uuid UNIQUE REFERENCES payment (id),
    reason text,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    created_by uuid REFERENCES app_user (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (property_id, idempotency_key),
    FOREIGN KEY (property_id, folio_id) REFERENCES folio (property_id, id)
  );
  CREATE INDEX payment_folio_idx ON payment (folio_id);
  CREATE INDEX payment_business_date_idx ON payment (property_id, business_date);

  CREATE FUNCTION folio_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'append_only: % rows are never changed or deleted', TG_TABLE_NAME;
  END $$;
  CREATE TRIGGER folio_line_append_only BEFORE UPDATE OR DELETE ON folio_line
    FOR EACH ROW EXECUTE FUNCTION folio_append_only();
  CREATE TRIGGER payment_append_only BEFORE UPDATE OR DELETE ON payment
    FOR EACH ROW EXECUTE FUNCTION folio_append_only();
  ```
  Folio nastaje lenjo (nema backfill-a): boravci iz 1a ga dobijaju pri prvom check-inu, zaduženju ili plaćanju.
- `idempotency.ts`:
  - `parseKey(body: Body): string` — polje `key`, `^[A-Za-z0-9_-]{8,100}$`, inače `422 validation_failed { field: 'key' }`.
  - `requestHash(route: string, subject: string, fields: Record<string, unknown>): string` — SHA-256 (hex) kanonskog JSON-a (ključevi sortirani) od `{ route, subject, fields }`.
- `FolioService` (sve metode koje pišu: `lockOpen(tx, pid, 'share')` → (red rezervacije kad treba) → `ensureFolio` → upis):
  - `ensureFolio(tx, propertyId, stayId): Promise<{ id: string; status: 'open' | 'closed' }>` — `INSERT … ON CONFLICT (property_id, stay_id) DO NOTHING`, pa `SELECT … FOR UPDATE`.
  - `balanceOf(tx, folioId): Promise<{ chargesMinor: number; paymentsMinor: number; balanceMinor: number }>` — jedan SQL upit; poziva se samo pod zaključanim folijom (ili u read-only transakciji za prikaz).
  - `postNight(tx, propertyId, folioId, stay: { id: string }, night: string, businessDate: string, source: 'night_audit' | 'check_out' | 'no_show'): Promise<boolean>` — iznos iz `stay_night.price_minor`, PDV iz `property_settings.accommodation_vat_bp`, opis `Smeštaj {D.M.YYYY}`, `INSERT … ON CONFLICT DO NOTHING` na `folio_line_night`; vraća da li je upisano. Noć bez `stay_night` reda → `Error` (programska greška, zaustavlja zatvaranje dana). Noć sa cenom 0 se ne knjiži (vraća `false`; `amount_minor <> 0`).
  - `charge(stayId, body, actor)`: `{ kind: 'service' | 'fee'; description: string (1..200); amountMinor: number; vatRateBp?: number | null; key }` → `201 LineView`. Boravak `expected` ili `in_house` (`409 stay_not_chargeable { status }`); `vatRateBp` mora biti u `vatRatesBp` iz podešavanja (`422 validation_failed { field: 'vatRateBp' }`).
  - `reverseLine(lineId, body: { reason: string (1..500); key }, actor)` → nova stavka `kind 'correction'`, `amount_minor = −original`, `source_type 'reversal'`; storno storna `422 cannot_reverse_correction`; drugi storno iste stavke `409 line_already_reversed` (pre upisa, a `UNIQUE` je rezerva).
  - `pay(stayId, body: { method: 'cash' | 'card' | 'transfer'; amountMinor: number; reference?: string (≤100); key }, actor)` → `201 PaymentView`; bilo koji status boravka osim zatvorenog folija; uplata veća od salda je dozvoljena (avans, saldo postaje negativan).
  - `refund(stayId, body: { method: 'cash' | 'card' | 'transfer'; amountMinor: number /* > 0 */; reason; key }, actor)` → plaćanje sa `−amountMinor`; samo kad je saldo negativan i `amountMinor ≤ −saldo` (`422 refund_exceeds_credit { creditMinor }`).
  - `voidPayment(paymentId, body: { reason; key }, actor)` → plaćanje `−original` sa `reverses_payment_id`; storno storna `422 cannot_void_reversal`; dvaput `409 payment_already_voided`.
  - Idempotentnost svih pet: posle zaključavanja folija ključ se traži u `folio_line` i `payment` (od Taska 8 i u `folio_document`), jer je `UNIQUE` po tabeli; isti `request_hash` vraća taj rezultat sa `200`, drugi heš (ili ključ iz druge tabele) `409 idempotency_key_reused`. Kad ključ stigne paralelno za isti folio, drugi zahtev čeka na red folija i nalazi prvi. Isti ključ za dva različita folija: drugi upis pada na `UNIQUE`, što servis prevodi u `409 idempotency_key_reused`.
  - Iznosi: ceo broj, `1 ≤ amountMinor ≤ 10_000_000_000` (100.000.000,00 RSD), inače `422 validation_failed { field: 'amountMinor' }`.
  - `view(stayId): Promise<FolioView>` (read-only transakcija, ne pravi folio): `{ id: string | null; stayId; reservationId; status: 'none' | 'open' | 'closed'; lines: LineView[]; payments: PaymentView[]; chargesMinor; paymentsMinor; balanceMinor; unpostedNights: Array<{ night: string; priceMinor: number }> }` (`unpostedNights`: noći boravka iz `stay_night` bez stavke smeštaja, za predračun i pregled odjave).
  - `LineView = { id; kind; description; amountMinor; vatRateBp: number | null; businessDate; night: string | null; sourceType; reversesLineId: string | null; reversedBy: string | null; reason: string | null; createdAt }`; `PaymentView = { id; method; amountMinor; businessDate; reference: string | null; reversesPaymentId: string | null; voidedBy: string | null; reason: string | null; createdAt }`.
  - Audit: `folio.charge`, `folio.reverse`, `folio.pay`, `folio.refund`, `folio.void` sa iznosom i poslovnim datumom.
- API (`hotel.folio`): `GET /stays/:id/folio` (`folio.view`), `POST /stays/:id/folio/charges` (`folio.charge`), `POST /folio-lines/:id/reverse` (`folio.correct`, owner/manager), `POST /stays/:id/folio/payments` (`folio.pay`), `POST /stays/:id/folio/refunds` (`folio.pay`, owner/manager), `POST /payments/:id/void` (`folio.correct`, owner/manager). Ostalo: owner/manager/receptionist. Prvi upis vraća `201`, ponovljen ključ `200`.

- [ ] **Step 1: Napiši testove koji padaju** (`folio.e2e-spec.ts`)

```ts
import { startFrontDesk, type FrontDesk } from './front-desk';

describe('folio (e2e)', () => {
  let fd: FrontDesk;
  let stayId: string;

  beforeAll(async () => {
    fd = await startFrontDesk();
  });
  beforeEach(async () => {
    await fd.reset();
    const { typeId, planId } = await fd.pricedType('DBL', 2);
    ({ stayId } = await fd.bookStay({ typeId, planId }, '2026-11-02', '2026-11-04'));
  });
  afterAll(() => fd.close());

  const charge = (amountMinor: number, key: string, cookie?: string) =>
    fd.post(`/stays/${stayId}/folio/charges`, { kind: 'service', description: 'Mini bar', amountMinor, key }, cookie);
  const pay = (amountMinor: number, key: string, method = 'cash') =>
    fd.post(`/stays/${stayId}/folio/payments`, { method, amountMinor, key });
  const folio = async () => (await fd.get(`/stays/${stayId}/folio`)).body;

  it('GET before any write shows an empty folio and creates nothing', async () => {
    expect(await folio()).toMatchObject({ id: null, status: 'none', balanceMinor: 0, lines: [], payments: [] });
    expect((await folio()).unpostedNights).toEqual([
      { night: '2026-11-02', priceMinor: 1_000_000 },
      { night: '2026-11-03', priceMinor: 1_000_000 },
    ]);
    expect(await fd.sql('SELECT 1 FROM folio')).toHaveLength(0);
  });

  it('balance is charges minus payments, on the open business date', async () => {
    expect((await charge(50_000, 'charge-0001')).status).toBe(201);
    expect((await pay(30_000, 'pay-00000001')).status).toBe(201);
    const f = await folio();
    expect(f).toMatchObject({ status: 'open', chargesMinor: 50_000, paymentsMinor: 30_000, balanceMinor: 20_000 });
    expect(f.lines).toEqual([
      expect.objectContaining({ kind: 'service', amountMinor: 50_000, businessDate: '2026-11-02', sourceType: 'manual' }),
    ]);
    expect(f.payments).toEqual([expect.objectContaining({ method: 'cash', amountMinor: 30_000, businessDate: '2026-11-02' })]);
  });

  it('the same key twice, even in parallel, records one payment; another body with that key is 409', async () => {
    const body = { method: 'card', amountMinor: 10_000, key: 'pay-retry-01' };
    const url = `/stays/${stayId}/folio/payments`;
    const [a, b] = await Promise.all([fd.post(url, body), fd.post(url, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(b.body.id).toBe(a.body.id);
    expect(await fd.sql('SELECT id FROM payment')).toHaveLength(1);
    const c = await fd.post(url, { ...body, amountMinor: 10_001 });
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('idempotency_key_reused');
  });

  it('a key used for a charge cannot be replayed as a payment', async () => {
    expect((await charge(50_000, 'shared-key-1')).status).toBe(201);
    const res = await pay(50_000, 'shared-key-1');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('idempotency_key_reused');
  });

  it('a reversal is a new negative line, once, by a manager only', async () => {
    const line = (await charge(50_000, 'charge-0002')).body;
    const byDesk = await fd.post(`/folio-lines/${line.id}/reverse`, { reason: 'Pogrešan unos', key: 'reverse-001' });
    expect(byDesk.body.code).toBe('forbidden_role');
    const rev = await fd.post(`/folio-lines/${line.id}/reverse`, { reason: 'Pogrešan unos', key: 'reverse-001' }, fd.manager);
    expect(rev.status).toBe(201);
    expect(rev.body).toMatchObject({ kind: 'correction', amountMinor: -50_000, reversesLineId: line.id });
    const again = await fd.post(`/folio-lines/${line.id}/reverse`, { reason: 'Opet', key: 'reverse-002' }, fd.manager);
    expect(again.body.code).toBe('line_already_reversed');
    const ofReversal = await fd.post(`/folio-lines/${rev.body.id}/reverse`, { reason: 'x', key: 'reverse-003' }, fd.manager);
    expect(ofReversal.body.code).toBe('cannot_reverse_correction');
    expect((await folio()).balanceMinor).toBe(0);
  });

  it('a refund needs a credit and cannot exceed it', async () => {
    await pay(30_000, 'pay-00000002');
    const tooMuch = await fd.post(
      `/stays/${stayId}/folio/refunds`,
      { method: 'cash', amountMinor: 30_001, reason: 'Povraćaj', key: 'refund-0001' },
      fd.manager,
    );
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body).toMatchObject({ code: 'refund_exceeds_credit', details: { creditMinor: 30_000 } });
    const ok = await fd.post(
      `/stays/${stayId}/folio/refunds`,
      { method: 'cash', amountMinor: 30_000, reason: 'Povraćaj', key: 'refund-0002' },
      fd.manager,
    );
    expect(ok.status).toBe(201);
    expect((await folio()).balanceMinor).toBe(0);
  });

  it.each([0, -1, 1.5, '100', 10_000_000_001])('amountMinor %p is 422 and writes nothing', async (amountMinor) => {
    const res = await fd.post(`/stays/${stayId}/folio/payments`, { method: 'cash', amountMinor, key: 'pay-bad-0001' });
    expect(res.status).toBe(422);
    expect(res.body.details).toEqual({ field: 'amountMinor' });
    expect(await fd.sql('SELECT 1 FROM payment')).toHaveLength(0);
  });

  it('the database refuses to change or delete a line or a payment', async () => {
    await charge(50_000, 'charge-0003');
    await pay(10_000, 'pay-00000003');
    await expect(fd.sql('UPDATE folio_line SET amount_minor = 1')).rejects.toThrow(/append_only/);
    await expect(fd.sql('DELETE FROM payment')).rejects.toThrow(/append_only/);
  });

  it('in safe mode payments and GET work; charges are safe_mode_blocked', async () => {
    fd.shiftLicence(400 * 86_400_000);
    expect((await pay(10_000, 'pay-00000004')).status).toBe(201);
    expect((await fd.get(`/stays/${stayId}/folio`)).status).toBe(200);
    const res = await charge(10_000, 'charge-0004');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('safe_mode_blocked');
  });
});
```

Dodatni testovi (imena): „housekeeping dobija 403 na GET folija"; „vatRateBp koji nije u podešavanjima: 422 sa field vatRateBp"; „storno plaćanja dvaput: 409 payment_already_voided"; „zaduženje na otkazanom boravku: 409 stay_not_chargeable"; „20 paralelnih plaćanja po 1.000 sa različitim ključevima: 20 redova i saldo tačno −20.000" (proverava da zaključavanje folija ne gubi upise). `upgrade.e2e-spec.ts`: `0010` se primenjuje na bazu sa podacima 1a i `folio` je prazan.

- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija.
- [ ] **Step 4:** `ci.sh` → PASS. Probe brisanjem (svaka posebno, test mora pasti iz navedenog razloga):
  - ukloni traženje postojećeg ključa → „the same key twice" pada (500 ili 409 umesto 200);
  - ukloni poređenje `request_hash` → „another body with that key is 409" pada;
  - ukloni triggere iz migracije u test bazi (`DROP TRIGGER`) → „the database refuses" pada;
  - ukloni proveru kredita u `refund` → „a refund needs a credit" pada.
- [ ] **Step 5:** Commit `Keep an append-only folio with idempotent charges and payments`.

---

### Task 5: Check-in i check-out [novac/konkurencija]

**Files:**
- Create: `apps/hotel-api/src/stays/{stay-lifecycle.service.ts,stay-lifecycle.controller.ts,stays.module.ts}`
- Create: `apps/hotel-api/test/stays.e2e-spec.ts`
- Modify: `apps/hotel-api/src/reservations/reservations.service.ts` (izvoz `scopeOfStay`, `inventoryOrder`; `cancel` ostaje kakav je), `apps/hotel-api/test/front-desk.ts` (`inHouse`)

**Interfaces:**
- `StayLifecycleService.checkIn(stayId, expectedVersion: unknown, actor): Promise<{ stayId; status: 'in_house'; version: number }>` — redosled: `lockOpen('share')` → red rezervacije `FOR UPDATE` (`version` ≠ → `409 version_conflict`; status ≠ `confirmed` → `409 reservation_not_confirmed`) → boravak `FOR UPDATE` (status ≠ `expected` → `409 stay_not_expected { status }`; `arrival ≠ businessDate` → `409 check_in_wrong_day { arrival, businessDate }`; `unit_id IS NULL` → `422 unit_required`) → red jedinice `FOR UPDATE` (neaktivna → `409 unit_inactive`; blokada preko `[businessDate, departure)` → `409 unit_blocked`) → `status = 'in_house'`, `checked_in_at/by`, `checked_in_business_date = businessDate` → `GuestsService.ensurePrimary` → `FolioService.ensureFolio` → `version + 1` → audit `stay.check_in`.
- `StayLifecycleService.checkOutPreview(stayId): Promise<CheckOutPreview>` (read-only) — `{ businessDate; keptUntil; earlyDeparture: boolean; nightsToPost: Array<{ night; priceMinor }>; nightsToRelease: string[]; balanceMinor /* posle knjiženja nightsToPost */ }`.
- `StayLifecycleService.checkOut(stayId, expectedVersion, actor): Promise<{ stayId; status: 'checked_out'; version; departure }>`. Pravilo (`B` = poslovni datum):
  - `keptUntil = max(B, arrival + 1 dan)`; po invarijanti zatvaranja dana (Task 6) `B ≤ departure`, pa `keptUntil ≤ departure`.
  - Noći `< keptUntil` bez stavke smeštaja knjiže se sa `source 'check_out'` i `business_date = B` (normalno samo noć dolaska kod odlaska istog dana).
  - Ako je `keptUntil < departure` (rani odlazak): `InventoryService.take(scope, keptUntil, departure, 'sold', -1)`, `stay.departure = keptUntil`, brišu se redovi `stay_night` od `keptUntil` (nisu folio; audit čuva staru vrednost i obrisane noći).
  - Saldo posle knjiženja mora biti 0, inače `409 folio_balance_open { balanceMinor }` i cela transakcija se poništava.
  - `status = 'checked_out'`, `checked_out_at/by`, `checked_out_business_date = B`, folio `closed`, `version + 1`, audit `stay.check_out` (sa `earlyDeparture`, `releasedNights`, `postedNights`).
  - Redosled: `lockOpen('share')` → rezervacija → boravak → scope/dani (samo rani odlazak) → folio.
- Dopuna `ReservationsService.book` i `quote` (pravilo 1a po kalendaru ostaje): posle `validateStayDates` čita se otvoreni poslovni dan običnim `SELECT`-om (bez zaključavanja i bez upisa; bez reda nema provere) i dolazak pre njega daje `422 arrival_before_business_date { arrival, businessDate, stay }`. Inače bi rezervacija za „danas" posle večernjeg zatvaranja dana bila nemoguća za check-in i tiho postala no-show.
- API (`hotel.core`, owner/manager/receptionist): `POST /stays/:id/check-in {version}` (`stay.check_in`), `GET /stays/:id/check-out-preview` (`stay.check_out`; čita, ali je deo odjave i radi u sigurnom režimu), `POST /stays/:id/check-out {version}` (`stay.check_out`).

- [ ] **Step 1: Napiši testove koji padaju** (`stays.e2e-spec.ts`)

```ts
import { startFrontDesk, type FrontDesk } from './front-desk';

describe('check-in and check-out (e2e)', () => {
  let fd: FrontDesk;
  let typeId: string;
  let planId: string;
  let unitIds: string[];

  beforeAll(async () => {
    fd = await startFrontDesk();
  });
  beforeEach(async () => {
    await fd.reset();
    ({ typeId, planId, unitIds } = await fd.pricedType('DBL', 2));
  });
  afterAll(() => fd.close());

  async function inHouse(arrival: string, departure: string) {
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, arrival, departure);
    const res = await fd.post(`/stays/${b.stayId}/check-in`, { version: b.version });
    expect(res.status).toBe(200);
    return { ...b, version: res.body.version as number };
  }
  const ledger = async (day: string) =>
    (await fd.sql<{ sold: number }>(`SELECT sold FROM inventory_day WHERE scope_id = $1 AND day = $2`, [typeId, day]))[0]?.sold;

  it('check-in on the arrival day: in house, holder is the primary guest, a folio exists, version + 1', async () => {
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-02', '2026-11-04');
    await fd.sql('DELETE FROM stay_guest WHERE stay_id = $1', [b.stayId]); // a stay as phase 1a left it
    const res = await fd.post(`/stays/${b.stayId}/check-in`, { version: b.version });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stayId: b.stayId, status: 'in_house', version: b.version + 1 });
    expect(await fd.sql('SELECT is_primary FROM stay_guest WHERE stay_id = $1', [b.stayId])).toEqual([{ is_primary: true }]);
    expect(await fd.sql(`SELECT status FROM folio WHERE stay_id = $1`, [b.stayId])).toEqual([{ status: 'open' }]);
  });

  it('check-in on another day than the business date is 409 naming both dates; nothing changes', async () => {
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-03', '2026-11-04');
    const res = await fd.post(`/stays/${b.stayId}/check-in`, { version: b.version });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'check_in_wrong_day',
      details: { arrival: '2026-11-03', businessDate: '2026-11-02' },
    });
    expect(await fd.sql('SELECT status FROM stay WHERE id = $1', [b.stayId])).toEqual([{ status: 'expected' }]);
  });

  it('check-in without a unit is 422 unit_required; with a stale version 409 version_conflict', async () => {
    const b = await fd.bookStay({ typeId, planId }, '2026-11-02', '2026-11-03');
    expect((await fd.post(`/stays/${b.stayId}/check-in`, { version: b.version })).body.code).toBe('unit_required');
    const c = await fd.bookStay({ typeId, planId, unitId: unitIds[1] }, '2026-11-02', '2026-11-03');
    expect((await fd.post(`/stays/${c.stayId}/check-in`, { version: c.version + 1 })).body.code).toBe('version_conflict');
  });

  it('check-out with an open balance is 409 with the amount and leaves everything as it was', async () => {
    const s = await inHouse('2026-11-02', '2026-11-03');
    const res = await fd.post(`/stays/${s.stayId}/check-out`, { version: s.version });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'folio_balance_open', details: { balanceMinor: 1_000_000 } });
    expect(await fd.sql('SELECT status FROM stay WHERE id = $1', [s.stayId])).toEqual([{ status: 'in_house' }]);
    expect(await fd.sql('SELECT 1 FROM folio_line')).toHaveLength(0);
  });

  it('leaving on the arrival day posts that night, closes the folio and frees the unit', async () => {
    const s = await inHouse('2026-11-02', '2026-11-03');
    const preview = (await fd.get(`/stays/${s.stayId}/check-out-preview`)).body;
    expect(preview).toEqual({
      businessDate: '2026-11-02',
      keptUntil: '2026-11-03',
      earlyDeparture: false,
      nightsToPost: [{ night: '2026-11-02', priceMinor: 1_000_000 }],
      nightsToRelease: [],
      balanceMinor: 1_000_000,
    });
    await fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'card', amountMinor: 1_000_000, key: 'pay-checkout-1' });
    const res = await fd.post(`/stays/${s.stayId}/check-out`, { version: s.version });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'checked_out', version: s.version + 1, departure: '2026-11-03' });
    const f = (await fd.get(`/stays/${s.stayId}/folio`)).body;
    expect(f).toMatchObject({ status: 'closed', balanceMinor: 0 });
    expect(f.lines).toEqual([expect.objectContaining({ kind: 'accommodation', night: '2026-11-02', sourceType: 'check_out' })]);
    const again = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-02', '2026-11-03');
    expect(again.stayId).toBeDefined(); // the exclusion constraint no longer holds the unit
  });

  it('an early departure gives back the unused nights and shortens the stay', async () => {
    const s = await inHouse('2026-11-02', '2026-11-05');
    expect([await ledger('2026-11-03'), await ledger('2026-11-04')]).toEqual([1, 1]);
    await fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'cash', amountMinor: 1_000_000, key: 'pay-early-001' });
    const res = await fd.post(`/stays/${s.stayId}/check-out`, { version: s.version });
    expect(res.status).toBe(200);
    expect(res.body.departure).toBe('2026-11-03');
    expect([await ledger('2026-11-02'), await ledger('2026-11-03'), await ledger('2026-11-04')]).toEqual([1, 0, 0]);
    expect(await fd.sql(`SELECT day::text AS day FROM stay_night WHERE stay_id = $1`, [s.stayId])).toEqual([
      { day: '2026-11-02' },
    ]);
  });

  it('a payment racing a check-out either lands first or is refused with folio_closed', async () => {
    const s = await inHouse('2026-11-02', '2026-11-03');
    await fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'cash', amountMinor: 1_000_000, key: 'pay-race-0001' });
    const [out, pay] = await Promise.all([
      fd.post(`/stays/${s.stayId}/check-out`, { version: s.version }),
      fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'cash', amountMinor: 5_000, key: 'pay-race-0002' }),
    ]);
    if (out.status === 200) {
      expect(pay.status).toBe(409);
      expect(pay.body.code).toBe('folio_closed');
    } else {
      expect(out.body).toMatchObject({ code: 'folio_balance_open', details: { balanceMinor: -5_000 } });
      expect(pay.status).toBe(201);
    }
    const f = (await fd.get(`/stays/${s.stayId}/folio`)).body;
    expect(f.status).toBe(out.status === 200 ? 'closed' : 'open');
    expect(f.balanceMinor).toBe(out.status === 200 ? 0 : -5_000); // a closed folio never carries a balance
  });

  it('in safe mode check-out works and check-in is safe_mode_blocked', async () => {
    const s = await inHouse('2026-11-02', '2026-11-03');
    const other = await fd.bookStay({ typeId, planId, unitId: unitIds[1] }, '2026-11-02', '2026-11-03');
    await fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'cash', amountMinor: 1_000_000, key: 'pay-safe-0001' });
    fd.shiftLicence(400 * 86_400_000);
    expect((await fd.post(`/stays/${other.stayId}/check-in`, { version: other.version })).body.code).toBe('safe_mode_blocked');
    expect((await fd.post(`/stays/${s.stayId}/check-out`, { version: s.version })).status).toBe(200);
  });
});
```

Napomena za trku: oba ishoda su ispravna, ali test u svakoj grani proverava ishod koji ne zavisi od servisa (oracle je iznos koji je test sam uplatio); poslednja provera hvata zatvoren folio sa saldom ≠ 0. Dodatni testovi (imena): „posle zatvaranja 2026-11-02 (sat i dalje 2026-11-02) rezervacija sa dolaskom 2026-11-02 je 422 arrival_before_business_date, a quote isto; dolazak 2026-11-03 prolazi"; „check-in na blokiranoj jedinici: 409 unit_blocked"; „check-out boravka koji nije u kući: 409 stay_not_in_house"; „housekeeping: 403 na check-in".

- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija; komentar o redosledu zaključavanja u `stay-lifecycle.service.ts` navodi tačke 0–6 iz Global Constraints.
- [ ] **Step 4:** `ci.sh` → PASS. Probe brisanjem (svaka posebno): (a) ukloni proveru salda → „check-out with an open balance" pada; (b) ukloni `take(…, -1)` kod ranog odlaska → „early departure" pada na `ledger`; (c) u `pay` ukloni `FOR UPDATE` nad folijom i proveru `status = 'closed'` → „payment racing" mora pasti bar jednom u 20 ponavljanja (privremeno `it.each(Array.from({ length: 20 }, (_, i) => i))`, samo za probu); (d) ukloni proveru dana → „wrong day" pada. Vrati sve.
- [ ] **Step 5:** Commit `Check guests in and out against the business date and a settled folio`.

---

### Task 6: Noćni audit: zatvaranje dana, no-show, izveštaj, automatsko zatvaranje [novac/konkurencija]

**Files:**
- Create: `apps/hotel-api/src/business-day/{night-audit.service.ts,night-audit.scheduler.ts}`
- Create: `apps/hotel-api/test/night-audit.e2e-spec.ts`
- Modify: `apps/hotel-api/src/business-day/business-day.controller.ts`, `apps/hotel-api/src/main.ts` (pokreće scheduler posle `LicenceService.start()`)

**Interfaces:**
- `NightAuditService.close(day: unknown, actor: Actor | null, mode: 'manual' | 'auto'): Promise<{ alreadyClosed: boolean; report: AuditReport }>` — jedna transakcija:
  1. `lockOpen('update')` → otvoreni dan `D`. Telo traži `day` (`YYYY-MM-DD`). Ako je `day` već zatvoren → `{ alreadyClosed: true, report }` iz sačuvanog reda (200, ništa se ne piše). Ako `day ≠ D` → `409 business_day_mismatch { open: D }`.
  2. `D > danas objekta` → `409 business_day_in_future { day: D, today }`.
  3. Blokada: `in_house` boravci sa `departure ≤ D` → `409 close_blocked { departures: [{ stayId, reservationId, number, unitName, departure }] }`.
  4. No-show: kandidati su `expected` boravci sa `arrival ≤ D` čija je rezervacija `confirmed`. `cancel` iz 1a ne uzima zaključavanje dana i može da završi dok zatvaranje čeka, pa je redosled obavezan: (i) izaberi `reservation_id` kandidata; (ii) zaključaj te redove rezervacija `FOR UPDATE` po `id`; (iii) **ponovo** pročitaj boravke `WHERE status = 'expected' AND arrival ≤ D` i rezervacije `WHERE status = 'confirmed'` (otkazani u međuvremenu ispadaju); tek onda za svaki: `status = 'no_show'`; `take(scope, arrival, departure, 'sold', -1)` u `inventoryOrder`; uz `no_show_charge = 'first_night'` `postNight(arrival, D, 'no_show')`; rezervacija čiji su svi boravci `no_show`/`cancelled` (bar jedan `no_show`) dobija `status = 'no_show'`; svaka promenjena rezervacija `version + 1`; audit `stay.no_show`.
  5. Knjiženje: za svaki `in_house` boravak sa `arrival ≤ D < departure` (po `stay.id`): `ensureFolio`, `postNight(D, D, 'night_audit')`. Upis koji ne uspe (nema `stay_night` za `D`) obara celu transakciju: `409 close_failed { stayId, night }`, dan ostaje otvoren.
  6. Izveštaj (`AuditReport`, jsonb, nepromenljiv):
     ```ts
     interface AuditReport {
       day: string; mode: 'manual' | 'auto'; closedAt: string; closedBy: string | null;
       arrivals: number;          // stays with checked_in_business_date = D
       departures: number;        // stays with checked_out_business_date = D (normal, early or same-day)
       inHouse: number;           // stays posted in step 5
       noShows: Array<{ stayId: string; number: string; guest: string; arrival: string; chargedMinor: number }>;
       roomRevenueMinor: number;  // accommodation lines with business_date = D
       chargesByKindMinor: Record<string, number>; // all lines with business_date = D, by kind
       paymentsByMethodMinor: Record<string, number>; // payments with business_date = D, by method
       postedNights: number;
     }
     ```
  7. `D` → `closed` (`closed_at`, `closed_by`, `close_mode`, `report`, `last_auto_error = null`), novi red `D + 1` → `open`; audit `business_day.close`.
- `NightAuditScheduler.runOnce(): Promise<'closed' | 'not_due' | 'blocked' | 'disabled'>` — `auto_close_time` null → `disabled`; lokalno vreme objekta < `(D + 1) auto_close_time` → `not_due`; inače `close(D, null, 'auto')`; `DomainError` → `last_auto_error = { at, code, details }` u posebnoj transakciji i `blocked`. `start()`/`stop()`: `setInterval(runOnce, 60_000).unref()`; dva preklopljena poziva se ne izvršavaju istovremeno (zastavica u procesu; zatvaranje je ionako idempotentno).
- API (`hotel.folio`, owner/manager/receptionist): `POST /business-day/close {day}` (`business_day.close`; `200` i za `alreadyClosed`), `GET /business-days?from&to` (`business_day.view`, najviše 62 dana, lista `{ day, closedAt, mode, roomRevenueMinor, noShows: number }`), `GET /business-days/:day` (`business_day.view`, `404 business_day_not_found`). `GET /business-day` (Task 3) dobija `blockers` (isti oblik kao `close_blocked`) i `pending: { arrivals: number; departures: number; inHouse: number }` za otvoreni dan.

- [ ] **Step 1: Napiši testove koji padaju** (`night-audit.e2e-spec.ts`)

```ts
import { NightAuditScheduler } from '../src/business-day/night-audit.scheduler';
import { startFrontDesk, type FrontDesk } from './front-desk';

describe('night audit (e2e)', () => {
  let fd: FrontDesk;
  let typeId: string;
  let planId: string;
  let unitIds: string[];

  beforeAll(async () => {
    fd = await startFrontDesk();
  });
  beforeEach(async () => {
    await fd.reset();
    ({ typeId, planId, unitIds } = await fd.pricedType('DBL', 3));
  });
  afterAll(() => fd.close());

  async function inHouse(unit: number, arrival: string, departure: string) {
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[unit] }, arrival, departure);
    const res = await fd.post(`/stays/${b.stayId}/check-in`, { version: b.version });
    expect(res.status).toBe(200);
    return { ...b, version: res.body.version as number };
  }
  const close = (day: string, cookie?: string) => fd.post('/business-day/close', { day }, cookie);
  const nightLines = () =>
    fd.sql<{ night: string; amount: string; business_date: string; source_type: string }>(
      `SELECT night::text AS night, amount_minor::text AS amount, business_date::text AS business_date, source_type
         FROM folio_line WHERE kind = 'accommodation' ORDER BY night`,
    );

  // Note: a stay leaving on 2026-11-03 does not block closing 2026-11-02; only departure <= D blocks.
  it('closing posts each in-house night once, opens the next day and stores the report', async () => {
    await inHouse(0, '2026-11-02', '2026-11-04');
    await inHouse(1, '2026-11-02', '2026-11-03');
    const res = await close('2026-11-02');
    expect(res.status).toBe(200);
    expect(res.body.alreadyClosed).toBe(false);
    expect(res.body.report).toMatchObject({
      day: '2026-11-02',
      mode: 'manual',
      arrivals: 2,
      inHouse: 2,
      postedNights: 2,
      noShows: [],
      roomRevenueMinor: 2_000_000,
      chargesByKindMinor: { accommodation: 2_000_000 },
    });
    expect(await nightLines()).toEqual([
      { night: '2026-11-02', amount: '1000000', business_date: '2026-11-02', source_type: 'night_audit' },
      { night: '2026-11-02', amount: '1000000', business_date: '2026-11-02', source_type: 'night_audit' },
    ]);
    expect((await fd.get('/business-day')).body).toMatchObject({ day: '2026-11-03', started: true });
  });

  it('closing the same day again returns the stored report and posts nothing', async () => {
    await inHouse(0, '2026-11-02', '2026-11-04');
    const first = await close('2026-11-02');
    fd.setNow(new Date('2026-11-03T08:00:00Z'));
    const second = await close('2026-11-02');
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ alreadyClosed: true, report: first.body.report });
    expect(await nightLines()).toHaveLength(1);
  });

  it('two closes in parallel: one posts, both answer the same report', async () => {
    await inHouse(0, '2026-11-02', '2026-11-04');
    const [a, b] = await Promise.all([close('2026-11-02'), close('2026-11-02', fd.manager)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.alreadyClosed, b.body.alreadyClosed].sort()).toEqual([false, true]);
    expect(a.body.report).toEqual(b.body.report);
    expect(await nightLines()).toHaveLength(1);
  });

  it('a guest due to leave who is still in house blocks the close, named in the error', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-03');
    await close('2026-11-02');
    fd.setNow(new Date('2026-11-03T22:00:00Z'));
    const res = await close('2026-11-03');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('close_blocked');
    expect(res.body.details.departures).toEqual([expect.objectContaining({ stayId: s.stayId, departure: '2026-11-03' })]);
    expect((await fd.get('/business-day')).body.day).toBe('2026-11-03');
  });

  it('a future day cannot be closed', async () => {
    await close('2026-11-02');
    const res = await close('2026-11-03'); // the clock still says 2026-11-02
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'business_day_in_future', details: { day: '2026-11-03', today: '2026-11-02' } });
  });

  it('a day other than the open one is 409 business_day_mismatch', async () => {
    const res = await close('2026-11-05');
    expect(res.body).toMatchObject({ code: 'business_day_mismatch', details: { open: '2026-11-02' } });
  });

  it('an expected stay whose arrival day closes becomes no_show and frees its unit and nights', async () => {
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-02', '2026-11-04');
    const res = await close('2026-11-02');
    expect(res.body.report.noShows).toEqual([expect.objectContaining({ stayId: b.stayId, chargedMinor: 0 })]);
    expect(await fd.sql('SELECT status FROM stay WHERE id = $1', [b.stayId])).toEqual([{ status: 'no_show' }]);
    expect(await fd.sql('SELECT status, version FROM reservation WHERE id = $1', [b.reservationId])).toEqual([
      { status: 'no_show', version: b.version + 1 },
    ]);
    expect(
      await fd.sql(`SELECT day::text AS day, sold FROM inventory_day WHERE scope_id = $1 AND day < '2026-11-04' ORDER BY day`, [typeId]),
    ).toEqual([
      { day: '2026-11-02', sold: 0 },
      { day: '2026-11-03', sold: 0 },
    ]);
  });

  it('with no_show_charge first_night the first night is posted to the no-show folio', async () => {
    await fd.put('/settings/business', { noShowCharge: 'first_night' });
    const b = await fd.bookStay({ typeId, planId, unitId: unitIds[0] }, '2026-11-02', '2026-11-04');
    const res = await close('2026-11-02');
    expect(res.body.report.noShows[0].chargedMinor).toBe(1_000_000);
    expect((await fd.get(`/stays/${b.stayId}/folio`)).body.lines).toEqual([
      expect.objectContaining({ kind: 'accommodation', night: '2026-11-02', sourceType: 'no_show', amountMinor: 1_000_000 }),
    ]);
  });

  it('a payment waiting on the close lands on the next business date', async () => {
    const s = await inHouse(0, '2026-11-02', '2026-11-04');
    const closing = close('2026-11-02');
    const paying = fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'cash', amountMinor: 1_000, key: 'pay-wait-0001' });
    const [c, p] = await Promise.all([closing, paying]);
    expect(c.status).toBe(200);
    expect(p.status).toBe(201);
    const inReport = c.body.report.paymentsByMethodMinor.cash ?? 0;
    expect(p.body.businessDate).toBe(inReport === 1_000 ? '2026-11-02' : '2026-11-03');
  });

  it('auto close: not due before the time, closes after it, records the reason when blocked', async () => {
    const scheduler = fd.app.get(NightAuditScheduler);
    expect(await scheduler.runOnce()).toBe('disabled');
    await fd.put('/settings/business', { autoCloseTime: '03:00' });
    fd.setNow(new Date('2026-11-03T01:59:00Z')); // 02:59 in Belgrade
    expect(await scheduler.runOnce()).toBe('not_due');
    fd.setNow(new Date('2026-11-03T02:00:00Z'));
    expect(await scheduler.runOnce()).toBe('closed');
    const day = await fd.get('/business-days/2026-11-02');
    expect(day.body.mode).toBe('auto');

    await inHouse(0, '2026-11-03', '2026-11-04');
    fd.setNow(new Date('2026-11-04T02:00:00Z'));
    expect(await scheduler.runOnce()).toBe('closed'); // closes 11-03, posts the night
    fd.setNow(new Date('2026-11-05T02:00:00Z'));
    expect(await scheduler.runOnce()).toBe('blocked'); // 11-04: the guest due to leave is still in house
    expect((await fd.get('/business-day')).body.lastAutoError).toMatchObject({ code: 'close_blocked' });
  });
});
```

Napomena o testu „payment waiting": oracle je izveštaj zatvaranja (nepromenljiv snimak), ne servis plaćanja; ako je plaćanje ušlo pre zatvaranja, mora biti u izveštaju sa datumom `2026-11-02`, inače posle sa `2026-11-03`. Ishod „u izveštaju, ali sa datumom 11-03" ili obrnuto znači da knjiženje nije čitalo dan pod zaključavanjem.

Dodatni testovi (imena): „otkazivanje i zatvaranje paralelno na istom expected boravku: boravak je ili `cancelled` ili `no_show`, `sold` nikad nije negativan, nijedan odgovor nije 500" (20 ponavljanja u jednom testu, svaki put nova rezervacija); „stari expected boravak sa dolaskom pre otvorenog dana (staging posle migracije) postaje no-show pri prvom zatvaranju" (`fd.sql` vraća `arrival` na `2026-10-30` posle booka, kao podaci iz `seedPhase1a`); „recepcionar može da zatvori dan, housekeeping ne"; „u sigurnom režimu zatvaranje radi i knjiži noćenje"; „GET /business-day pokazuje blockers i pending pre zatvaranja"; „GET /business-days lista zatvorenih dana sa prihodom".

- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija. `main.ts`: `app.get(NightAuditScheduler).start()` posle licence; `OnModuleDestroy` zove `stop()`.
- [ ] **Step 4:** `ci.sh` → PASS. Probe brisanjem (svaka posebno): (a) ukloni `ON CONFLICT DO NOTHING` u `postNight` i proveru „već zatvoren" → „two closes in parallel" pada (drugo zatvaranje je 409 ili dupla stavka); (b) ukloni proveru `departure ≤ D` → „blocks the close" pada; (c) ukloni `take(-1)` kod no-show → test inventara pada; (c2) ukloni ponovno čitanje posle zaključavanja rezervacija (korak 4.iii) → test „otkazivanje i zatvaranje paralelno" pada sa 500 bar u jednom ponavljanju; (d) promeni `lockOpen('update')` u `'share'` u `close` → „a payment waiting" mora pasti bar jednom u 20 ponavljanja (privremeni `it.each`, kao u Tasku 5); (e) ukloni proveru `D > today` → „a future day" pada. Vrati sve.
- [ ] **Step 5:** Commit `Close the business day with a night audit that posts, marks no-shows and reports once`.

---

### Task 7: Pun pravni profil objekta

**Files:**
- Create: `apps/hotel-api/src/db/migrations/0011_legal_profile.sql`
- Create: `apps/hotel-api/src/legal/{legal-ids.ts,legal-ids.spec.ts,legal-profile.service.ts,legal-profile.controller.ts,legal.module.ts}`
- Create: `apps/hotel-api/test/legal-profile.e2e-spec.ts`
- Modify: `test/upgrade.e2e-spec.ts`, `apps/hotel-api/src/auth/setup.service.ts` (samo ako `POST /setup/owner` treba da upiše `fiscal_mode`; podrazumevana vrednost iz `kind` dolazi iz servisa)

**Interfaces:**
- `0011_legal_profile.sql`:
  ```sql
  ALTER TABLE legal_profile
    ADD COLUMN legal_name text,
    ADD COLUMN address text,
    ADD COLUMN postal_code text,
    ADD COLUMN city text,
    ADD COLUMN activity_code text,
    ADD COLUMN bank_account text,
    ADD COLUMN email text,
    ADD COLUMN phone text,
    ADD COLUMN accommodation_category text CHECK (accommodation_category IN
      ('hotel','motel','hostel','guest_house','apartment','room','house','rural_household','other')),
    ADD COLUMN categorization_number text,
    ADD COLUMN fiscal_mode text NOT NULL DEFAULT 'disabled' CHECK (fiscal_mode IN ('required','invoice_only','disabled')),
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
  UPDATE legal_profile SET fiscal_mode = CASE kind WHEN 'natural_person' THEN 'disabled' ELSE 'required' END;
  ```
  Ništa nije `NOT NULL` bez podrazumevane vrednosti: postojeći red Demo Hotela ostaje ispravan, a nedostajuća polja UI prikazuje kao „nije popunjeno".
- `legal-ids.ts` (čiste funkcije):
  - `isValidPib(v: string): boolean` — 9 cifara, kontrolna cifra ISO 7064 MOD 11,10:
    ```ts
    let p = 10;
    for (let i = 0; i < 8; i++) { let s = (Number(v[i]) + p) % 10; if (s === 0) s = 10; p = (2 * s) % 11; }
    return (11 - p) % 10 === Number(v[8]);
    ```
  - `isValidJmbg(v: string): boolean` — 13 cifara, `m = 11 − ((7(a+g) + 6(b+h) + 5(c+i) + 4(d+j) + 3(e+k) + 2(f+l)) mod 11)`, `m > 9 → 0`, `m === m13`; plus datum `DDMMYYY` mora biti stvaran dan.
  - `isValidMb(v: string): boolean` — tačno 8 cifara (kontrolna cifra matičnog broja se ne proverava: algoritam nije potvrđen na stvarnim brojevima, otvoreno pitanje 3).
  - `isValidBankAccount(v: string): boolean` — `^\d{3}-\d{1,13}-\d{2}$`.
  - `maskJmbg(v: string): string` → `'•••••••••' + poslednje 4`.
- `LegalProfileService.get(): Promise<LegalProfileView>`; `update(input, actor)`:
  - `LegalProfileView = { kind; legalName; taxId; registryId /* JMBG maskiran za natural_person */; vatPayer; address; postalCode; city; activityCode; bankAccount; email; phone; accommodationCategory; categorizationNumber; fiscalMode; fiscalNotice: 'not_available_yet' | null; complete: boolean; missing: string[] }`. `fiscalNotice = 'not_available_yet'` kad je `fiscalMode = 'required'` (UI: „Fiskalizacija još nije uključena; plaćanja se beleže bez fiskalnog računa"). `missing` su polja potrebna za račune (`legalName`, `address`, `city`, a za pravno lice i preduzetnika `taxId` i `registryId`).
  - Pravila: `legal_entity` i `entrepreneur` → `taxId` (PIB) i `registryId` (MB) obavezni i ispravni; `natural_person` → `registryId` je JMBG (ispravan), `taxId` opciono (PIB ako postoji). Ako `registryId` za `natural_person` stigne maskiran (počinje sa `•`), zadržava se postojeća vrednost. Greška: `422 validation_failed { field }` sa porukom na srpskom (npr. „PIB nije ispravan: kontrolna cifra se ne slaže.").
  - `fiscalMode` se čuva, ali se u 1b ne koristi ni za šta osim `fiscalNotice`.
  - Audit `legal_profile.update` sa maskiranim JMBG-om u `before` i `after`.
- API (`hotel.core`): `GET /legal-profile` (`legal_profile.view`, owner/manager), `PUT /legal-profile` (`legal_profile.manage`, owner/manager).

- [ ] **Step 1: Testovi koji padaju**
  - `legal-ids.spec.ts` (vektori su stvarni javni PIB-ovi i ručno izračunat JMBG, nezavisno od implementacije):
    ```ts
    import { isValidJmbg, isValidMb, isValidPib, maskJmbg } from './legal-ids';

    it.each(['100002887', '104052135', '100001378', '101670560'])('PIB %s of a real company is valid', (pib) => {
      expect(isValidPib(pib)).toBe(true);
    });
    it.each(['100002888', '10000288', '1000028870', '10000288a'])('PIB %s is refused', (pib) => {
      expect(isValidPib(pib)).toBe(false);
    });
    it('JMBG: check digit and date', () => {
      expect(isValidJmbg('0101990710008')).toBe(true);
      expect(isValidJmbg('0101990710007')).toBe(false); // wrong check digit
      expect(isValidJmbg('3102990710005')).toBe(false); // 31 Feb
      expect(isValidJmbg('010199071000')).toBe(false);
    });
    it('MB is exactly eight digits', () => {
      expect(isValidMb('07036540')).toBe(true);
      expect(isValidMb('7036540')).toBe(false);
    });
    it('mask keeps only the last four digits', () => {
      expect(maskJmbg('0101990710008')).toBe('•••••••••0008');
    });
    ```
    Implementer pre pisanja izračuna kontrolnu cifru za `3102990710005` i podesi poslednju cifru tako da je kontrolna cifra ispravna (test mora pasti zbog datuma, ne zbog cifre); to upisuje u komentar testa.
  - `legal-profile.e2e-spec.ts` (imena): „pravno lice: neispravan PIB 422 field taxId, ništa nije upisano"; „preduzetnik bez MB: 422 field registryId"; „fizičko lice: JMBG se čuva, GET i audit ga vraćaju maskiranog"; „PUT sa maskiranim JMBG-om zadržava stari"; „fiscalMode required daje fiscalNotice not_available_yet"; „missing navodi prazna polja za račun"; „recepcionar: 403 forbidden_role na GET"; „u sigurnom režimu GET radi, PUT safe_mode_blocked".
  - `upgrade.e2e-spec.ts`: `0011` na redu `legal_entity` iz `seedPhase1a` daje `fiscal_mode = 'required'`, nova polja su `NULL`, `tax_id` i `registry_id` nepromenjeni.
- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija.
- [ ] **Step 4:** `ci.sh` → PASS. Probe brisanjem: (a) ukloni proveru kontrolne cifre PIB-a → test „100002888 is refused" pada; (b) ukloni maskiranje u auditu → test fizičkog lica pada (`after` sadrži pun JMBG); vrati.
- [ ] **Step 5:** Commit `Store the full legal profile of the property`.

---

### Task 8: Nefiskalni račun i predračun [novac]

**Files:**
- Create: `apps/hotel-api/src/db/migrations/0012_documents.sql`
- Create: `apps/hotel-api/src/folio/documents.service.ts`
- Create: `apps/hotel-api/test/documents.e2e-spec.ts`
- Modify: `apps/hotel-api/src/folio/folio.controller.ts`, `test/upgrade.e2e-spec.ts`

**Interfaces:**
- `0012_documents.sql`:
  ```sql
  CREATE TABLE document_counter (
    property_id uuid NOT NULL REFERENCES property (id),
    kind text NOT NULL CHECK (kind IN ('receipt', 'proforma')),
    year int NOT NULL,
    last int NOT NULL,
    PRIMARY KEY (property_id, kind, year)
  );
  CREATE TABLE folio_document (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id uuid NOT NULL REFERENCES property (id),
    folio_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('receipt', 'proforma')),
    number text NOT NULL,
    business_date date NOT NULL,
    content jsonb NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    issued_by uuid REFERENCES app_user (id),
    issued_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (property_id, number),
    UNIQUE (property_id, idempotency_key),
    FOREIGN KEY (property_id, folio_id) REFERENCES folio (property_id, id)
  );
  CREATE TRIGGER folio_document_append_only BEFORE UPDATE OR DELETE ON folio_document
    FOR EACH ROW EXECUTE FUNCTION folio_append_only();
  ```
- `DocumentsService.issue(stayId, body: { kind: 'receipt' | 'proforma'; key }, actor): Promise<DocumentView>` — `lockOpen('share')` → `ensureFolio` (red folija) → brojač → snimak. Broj: `N-{godina poslovnog datuma}-{6 cifara}` za račun, `P-…` za predračun, bez rupa (brojač se poništava sa transakcijom). Redosled zaključavanja: folio pa brojač nije dozvoljen (tačka 5 pre 6), pa servis uzima brojač pre folija: `lockOpen` → `document_counter` (`INSERT … ON CONFLICT DO UPDATE … RETURNING`) → `ensureFolio`. Neuspeh posle brojača poništava i broj.
  - Nefiskalni račun: samo za folio sa bar jednom stavkom ili plaćanjem; sadrži knjižene stavke, plaćanja i saldo. Predračun: knjižene stavke + `unpostedNights` kao očekivane stavke, plaćanja i iznos za uplatu.
  - `content` (snimak, nikad se ne preračunava):
    ```ts
    interface DocumentContent {
      kind: 'receipt' | 'proforma'; number: string; issuedAt: string; businessDate: string;
      notice: 'Ovo nije fiskalni račun.';
      seller: { legalName: string | null; taxId: string | null; registryId: string | null /* JMBG maskiran */;
                address: string | null; postalCode: string | null; city: string | null; bankAccount: string | null; vatPayer: boolean };
      guest: { name: string; email: string | null };
      reservation: { number: string; arrival: string; departure: string; unit: string | null };
      lines: Array<{ description: string; night: string | null; amountMinor: number; vatRateBp: number | null; expected: boolean }>;
      payments: Array<{ method: string; amountMinor: number; businessDate: string }>;
      totalMinor: number; paidMinor: number; dueMinor: number;
      vat: Array<{ rateBp: number; baseMinor: number; vatMinor: number }> | null; // only when vatPayer and every line has a rate
    }
    ```
    PDV je sadržan u ceni: `vatMinor = round(amount × rate / (10000 + rate))` po stopi (zbir po stopi, pa jedno zaokruživanje na ceo minor, half-up preko `@platform/money`), `baseMinor = zbir − vatMinor`.
  - Idempotentnost i `409 idempotency_key_reused` kao u Tasku 4.
- API (`hotel.folio`): `POST /stays/:id/folio/documents {kind, key}` (`folio.document`), `GET /stays/:id/folio/documents` (`folio.view`, lista `{ id, kind, number, issuedAt }`), `GET /folio-documents/:id` (`folio.view`, ceo `DocumentView = { id; kind; number; issuedAt; content: DocumentContent }`).

- [ ] **Step 1: Testovi koji padaju** (`documents.e2e-spec.ts`; `beforeEach` kao u Tasku 6: `pricedType('DBL', 3)` daje `typeId`, `planId`, `unitIds`; `inHouse(i, …)` je `fd.inHouse({ typeId, planId, unitId: unitIds[i] }, …)`):

```ts
  it('a receipt snapshots lines, payments and VAT included in the price', async () => {
    await fd.put('/legal-profile', {
      kind: 'legal_entity', legalName: 'Demo d.o.o.', taxId: '100002887', registryId: '07036540',
      vatPayer: true, address: 'Glavna 1', postalCode: '11000', city: 'Beograd',
    });
    await fd.put('/settings/business', { accommodationVatBp: 1000, vatRatesBp: [2000] });
    const s = await inHouse(0, '2026-11-02', '2026-11-03');
    await fd.post(`/stays/${s.stayId}/folio/charges`, { kind: 'service', description: 'Mini bar', amountMinor: 120_000, vatRateBp: 2000, key: 'charge-doc-01' });
    await fd.post('/business-day/close', { day: '2026-11-02' });
    await fd.post(`/stays/${s.stayId}/folio/payments`, { method: 'card', amountMinor: 1_120_000, key: 'pay-doc-0001' });
    const res = await fd.post(`/stays/${s.stayId}/folio/documents`, { kind: 'receipt', key: 'doc-receipt-1' });
    expect(res.status).toBe(201);
    expect(res.body.number).toBe('N-2026-000001');
    expect(res.body.content).toMatchObject({
      notice: 'Ovo nije fiskalni račun.',
      totalMinor: 1_120_000,
      paidMinor: 1_120_000,
      dueMinor: 0,
      vat: [
        { rateBp: 1000, baseMinor: 909_091, vatMinor: 90_909 },   // 1.000.000 × 10/110 = 90.909,09
        { rateBp: 2000, baseMinor: 100_000, vatMinor: 20_000 },   // 120.000 × 20/120
      ],
    });
  });

  it('a pro-forma before arrival lists the expected nights and the amount due', async () => {
    const b = await fd.bookStay({ typeId, planId }, '2026-11-05', '2026-11-07');
    await fd.post(`/stays/${b.stayId}/folio/payments`, { method: 'transfer', amountMinor: 500_000, key: 'pay-advance-01' });
    const res = await fd.post(`/stays/${b.stayId}/folio/documents`, { kind: 'proforma', key: 'doc-proforma-1' });
    expect(res.body.number).toBe('P-2026-000001');
    expect(res.body.content).toMatchObject({ totalMinor: 2_000_000, paidMinor: 500_000, dueMinor: 1_500_000 });
    expect(res.body.content.lines.every((l: { expected: boolean }) => l.expected)).toBe(true);
  });
```

  Ostali (imena): „numeracija je po vrsti i godini, bez rupa kad izdavanje padne" (prisilan pad posle brojača: dokument za boravak bez stavki daje `409 document_empty`, sledeći broj je i dalje `000001`); „snimak se ne menja posle storna stavke"; „isti ključ dvaput: jedan dokument"; „u sigurnom režimu izdavanje radi"; „seller.registryId fizičkog lica je maskiran"; `upgrade.e2e-spec.ts` za `0012`.
- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija.
- [ ] **Step 4:** `ci.sh` → PASS. Probe brisanjem: (a) uzmi broj iz brojača u zasebnoj transakciji (pre glavne) → „bez rupa" pada (sledeći broj je `000002`); (b) ukloni oznaku `notice` → test računa pada; (c) ukloni trigger `folio_document_append_only` → test „snimak se ne menja" (koji pokušava `UPDATE folio_document`) pada. Vrati.
- [ ] **Step 5:** Commit `Issue non-fiscal receipts and pro-forma invoices as immutable snapshots`.

---

### Task 9: Email potvrde kroz outbox

**Files:**
- Create: `apps/hotel-api/src/db/migrations/0013_outbox.sql`
- Create: `apps/hotel-api/src/mail/{mail-transport.ts,smtp.transport.ts,templates.ts,templates.spec.ts,outbox.service.ts,outbox.dispatcher.ts,messages.controller.ts,mail.module.ts}`
- Create: `apps/hotel-api/test/{fake-smtp.ts,outbox.e2e-spec.ts}`
- Modify: `apps/hotel-api/package.json` (`nodemailer` ^6.9.14, dev `@types/nodemailer` ^6.4.15, dev `smtp-server` ^3.13.4, dev `@types/smtp-server` ^3.5.10), `pnpm-lock.yaml` (`ci.sh --lock`), `reservations.service.ts` (`bookIn` i `cancel` upisuju poruku), `main.ts` (pokreće dispečer), `.env.example`, `test/upgrade.e2e-spec.ts`, `test/front-desk.ts` (`mail: FakeMailTransport`)

**Interfaces:**
- `0013_outbox.sql`:
  ```sql
  CREATE TABLE outbox_message (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id uuid NOT NULL REFERENCES property (id),
    channel text NOT NULL CHECK (channel IN ('email')),
    template text NOT NULL CHECK (template IN ('reservation_confirmed', 'reservation_cancelled')),
    idempotency_key text NOT NULL,
    reservation_id uuid,
    recipient text,
    payload jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
    attempts int NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL,  -- always from CLOCK, never the database's now()
    lease_until timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz,
    UNIQUE (property_id, idempotency_key),
    FOREIGN KEY (property_id, reservation_id) REFERENCES reservation (property_id, id)
  );
  CREATE INDEX outbox_due_idx ON outbox_message (next_attempt_at) WHERE status IN ('pending', 'sending');
  CREATE TABLE outbox_attempt (
    id bigserial PRIMARY KEY,
    property_id uuid NOT NULL REFERENCES property (id),
    message_id uuid NOT NULL REFERENCES outbox_message (id),
    at timestamptz NOT NULL,
    ok boolean NOT NULL,
    error text
  );
  ```
  Bez backfill-a: postojeće rezervacije ne dobijaju naknadne mejlove.
- `mail-transport.ts`:
  ```ts
  export interface MailMessage { to: string; from: string; replyTo?: string; subject: string; text: string; html: string; messageId: string }
  export class MailError extends Error { constructor(readonly code: string, message: string, readonly permanent: boolean) }
  export interface MailTransport { readonly configured: boolean; send(m: MailMessage): Promise<void> }
  export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
  export class NoopMailTransport implements MailTransport // configured = false; send baca MailError('smtp_not_configured', 'SMTP nije podešen.', false)
  ```
  `SmtpMailTransport` (nodemailer) iz env: `SMTP_HOST`, `SMTP_PORT` (podrazumevano 587), `SMTP_SECURE` (`true` = TLS od početka), `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`; bez `SMTP_HOST` ili `MAIL_FROM` → `NoopMailTransport` i jedna linija u logu pri pokretanju (bez vrednosti). SMTP odgovor `5xx` → `permanent: true`; mreža, timeout (20 s) i `4xx` → `false`.
- `templates.ts`: `render(template, payload, propertyName): { subject; text; html }` — srpski, latinica. `ReservationPayload = { number; holderName; arrival; departure; stays: Array<{ unitTypeName: string | null; unitName: string | null; arrival; departure; adults; children; totalMinor }>; totalMinor; propertyName; propertyEmail: string | null; propertyPhone: string | null }`. Naslovi: „Potvrda rezervacije {number} — {propertyName}" i „Otkazana rezervacija {number} — {propertyName}". Sve vrednosti u HTML-u prolaze kroz `escapeHtml`; iznosi preko `format` iz `@platform/money` (`10.000,00 RSD`), datumi `D.M.YYYY`.
- `OutboxService.enqueue(tx, propertyId, e: { template; reservationId; recipient: string | null; payload; key: string }): Promise<void>` — `INSERT … ON CONFLICT (property_id, idempotency_key) DO NOTHING`; bez primaoca `status = 'skipped'`, `last_error = 'Gost nema e-adresu.'`. Ključevi: `reservation_confirmed:{reservationId}`, `reservation_cancelled:{reservationId}`. `bookIn` poziva posle upisa rezervacije (rana vraćanja `findExternal` ne stižu do njega); `cancel` posle promene statusa.
- **Vreme outboxa je uvek iz `CLOCK`** (parametar upita), nikad SQL `now()`: test sat (`NOW = 2026-11-02`) je iza stvarnog vremena baze, pa bi poruka sa `DEFAULT now()` u testu bila „u budućnosti". Isto važi za `outbox_attempt.at` (upisuje se iz `CLOCK`). `enqueue` upisuje `next_attempt_at = clock()`.
- `OutboxDispatcher.runOnce(limit = 20): Promise<{ sent: number; failed: number; retried: number }>` — `now = clock()`; preuzimanje u kratkoj transakciji: `SELECT … WHERE (status = 'pending' OR (status = 'sending' AND lease_until < $now)) AND next_attempt_at <= $now ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT n` → `status = 'sending'`, `lease_until = now + 5 min`; slanje van transakcije; rezultat u novoj transakciji: `outbox_attempt` red, `sent` ili ponovni pokušaj posle `[1, 5, 30, 120, 360]` minuta (`attempts` 1..5), šesti neuspeh ili `permanent` → `failed`. `messageId` = `<{outbox id}@hotel>` (ponovljeno slanje istog reda nosi isti ID). Vreme iz `CLOCK`. `start()`/`stop()`: `setInterval(runOnce, 15_000).unref()`.
- API: `GET /reservations/:id/messages` (`hotel.core`, `message.view`; lista `{ id, template, recipient, status, attempts, lastError, nextAttemptAt, sentAt, history: [{ at, ok, error }] }`), `POST /messages/:id/resend` (`message.resend`, owner/manager/receptionist; `failed` ili `pending` → `pending`, `next_attempt_at = now`; `sent` → `409 message_already_sent`; `skipped` → `409 message_has_no_recipient`; audit `message.resend`).

- [ ] **Step 1: Testovi koji padaju**
  - `templates.spec.ts`: „potvrda: naslov, broj, datumi 2.11.2026 i ukupno 20.000,00 RSD u tekstu i HTML-u"; „ime gosta `<script>` je escapovano u HTML-u, doslovno u tekstu"; „otkaz ima svoj naslov".
  - `outbox.e2e-spec.ts` (`FakeMailTransport` iz `front-desk.ts`, beleži poruke, može da baci `MailError`):
    ```ts
    it('booking enqueues one confirmation in the same transaction; a failed booking enqueues nothing', async () => {
      const { typeId, planId } = await fd.pricedType('DBL', 1);
      await fd.bookStay({ typeId, planId }, '2026-11-05', '2026-11-06');
      const full = await fd.post('/reservations', {
        source: 'front_desk', holder: { firstName: 'Ana', lastName: 'Anić', email: 'ana@example.com' },
        stays: [{ unitTypeId: typeId, arrival: '2026-11-05', departure: '2026-11-06', adults: 2, ratePlanId: planId }],
      });
      expect(full.body.code).toBe('no_availability');
      expect(await fd.sql(`SELECT template, status, recipient FROM outbox_message`)).toEqual([
        { template: 'reservation_confirmed', status: 'pending', recipient: 'petar@example.com' },
      ]);
    });

    it('the dispatcher sends once, records the attempt and retries a temporary failure with backoff', async () => {
      const { typeId, planId } = await fd.pricedType('DBL', 1);
      await fd.bookStay({ typeId, planId }, '2026-11-05', '2026-11-06');
      fd.mail.failNext(new MailError('smtp_down', 'Server ne odgovara.', false));
      expect(await fd.dispatcher.runOnce()).toEqual({ sent: 0, failed: 0, retried: 1 });
      expect(await fd.dispatcher.runOnce()).toEqual({ sent: 0, failed: 0, retried: 0 }); // not due for 1 minute
      fd.setNow(new Date(NOW.getTime() + 61_000));
      expect(await fd.dispatcher.runOnce()).toEqual({ sent: 1, failed: 0, retried: 0 });
      expect(fd.mail.sent).toHaveLength(1);
      expect(fd.mail.sent[0].subject).toMatch(/^Potvrda rezervacije R-2026-000001/);
      expect(await fd.sql(`SELECT ok FROM outbox_attempt ORDER BY id`)).toEqual([{ ok: false }, { ok: true }]);
    });
    ```
    Ostali (imena): „holder bez e-adrese: skipped sa razlogom, dispečer ga ne dira"; „isti channel+externalId dvaput: jedna poruka"; „otkazivanje dodaje poruku o otkazu"; „trajna greška (permanent) odmah failed"; „šest privremenih neuspeha: failed"; „dva dispečera paralelno: poruka poslata tačno jednom" (`Promise.all([runOnce(), runOnce()])`, `fd.mail.sent` dužine 1); „istekao lease (`sending` starije od 5 min) se ponovo preuzima"; „resend failed poruke je šalje; resend sent poruke 409"; „bez SMTP podešavanja Noop beleži neuspeh `SMTP nije podešen.` i poruka ostaje vidljiva"; „SmtpMailTransport protiv `test/fake-smtp.ts` (`smtp-server` na slučajnom portu, bez TLS-a): poruka stiže sa From, To, Subject i Message-ID"; „GET /reservations/:id/messages ne otkriva poruke drugog objekta" nije moguć (jedan objekat), pa umesto toga „housekeeping: 403".
  - `upgrade.e2e-spec.ts` za `0013`.
- [ ] **Step 2:** `infrastructure/nas/ci.sh --lock` (novi paketi, lockfile se vraća na računar), zatim `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija. `.env.example` dobija `SMTP_HOST=`, `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER=`, `SMTP_PASSWORD=`, `MAIL_FROM=` sa komentarom da se vrednosti nikad ne commituju.
- [ ] **Step 4:** `ci.sh` → PASS. Probe brisanjem: (a) ukloni `FOR UPDATE SKIP LOCKED` i postavljanje `status = 'sending'` → „dva dispečera paralelno" pada (dve poslate poruke); (b) ukloni `escapeHtml` → test šablona pada; (c) ukloni `ON CONFLICT DO NOTHING` u `enqueue` → „isti channel+externalId dvaput" pada. Da je upis u istoj transakciji kao rezervacija dokazuje test „a failed booking enqueues nothing" samo delimično (neuspeh je pre `enqueue`), pa dodaj test „greška posle enqueue poništava i poruku": privremeno ubrizgan izuzetak posle `enqueue` (preko test-only `jest.spyOn(AuditService.prototype, 'record')` koji baci) → nema ni rezervacije ni poruke. Vrati.
- [ ] **Step 5:** Commit `Send reservation emails through an outbox with retries and a visible history`.

---

### Task 10: hotel-web: check-in, check-out i gosti na stranici rezervacije

**Files:**
- Create: `apps/hotel-web/src/components/{stay-actions.tsx,stay-actions.test.tsx,stay-guests.tsx,stay-guests.test.tsx,reservation-messages.tsx}`, `apps/hotel-web/src/lib/idempotency.ts`
- Modify: `apps/hotel-web/src/components/reservation-detail.tsx`, `apps/hotel-web/src/lib/types.ts`, `apps/hotel-web/src/lib/messages.ts`

**Interfaces:**
- Consumes: Task 2 (gosti), Task 5 (`check-in`, `check-out-preview`, `check-out`), Task 9 (`GET /reservations/:id/messages`, resend), `GET /business-day` (Task 3/6).
- Produces:
  - `newKey(): string` — `crypto.randomUUID()`; jedan ključ po otvaranju forme/dijaloga, isti za ponovljeni klik (dugme je onemogućeno dok zahtev traje, a ponovni pokušaj posle mrežne greške šalje isti ključ).
  - `StayActions({ stay, reservation, businessDate, readOnly, onChanged })`: „Prijavi gosta" (vidljivo za `expected` kad je `arrival === businessDate`; kad je `arrival > businessDate` tekst „Dolazak {D.M.}"; kad je `arrival < businessDate` ništa); „Odjavi gosta" otvara pregled iz `check-out-preview` (noći koje se knjiže, rani odlazak sa noćima koje se oslobađaju, saldo) sa linkom „Folio" kad saldo ≠ 0 i dugmetom „Potvrdi odjavu" samo kad je saldo 0. Status boravka kao oznaka (`STAY_STATUS_LABELS` dobija `no_show: 'Nije došao'`).
  - `StayGuests({ stay, readOnly })`: lista gostiju sa oznakom „Nosilac", dodavanje (pretraga postojećih `GET /guests?q` ili novi gost), uklanjanje, „Postavi kao nosioca"; dugme „Dodaj gosta" onemogućeno kad je broj gostiju = odrasli + deca.
  - `ReservationMessages({ reservationId })`: status poslatih mejlova („Poslato", „Čeka slanje", „Nije poslato: {razlog}", „Gost nema e-adresu") i „Pošalji ponovo".
  - Poruke za nove kodove u `messages.ts`: `check_in_wrong_day` → „Dolazak je {arrival}, a poslovni dan je {businessDate}. Zatvorite poslovni dan pre prijave gosta." (kad je `arrival > businessDate`), `unit_required` → „Prvo dodelite jedinicu boravku.", `folio_balance_open` → „Saldo foliјa nije nula ({balanceMinor}). Naplatite ili vratite razliku pre odjave.", `stay_not_expected`, `stay_not_in_house`, `too_many_guests`, `guest_already_on_stay`, `primary_guest_required`, `stay_not_editable`, `message_already_sent`, `message_has_no_recipient`. Iznos u poruci kroz `formatRsd`.
- [ ] **Step 1: Testovi** (Vitest, lažan `fetch`): „dugme Prijavi gosta postoji samo za dolazak na poslovni dan"; „409 check_in_wrong_day prikazuje oba datuma i uputstvo za zatvaranje dana"; „pregled odjave sa saldom 5.000,00 prikazuje link Folio i nema dugme Potvrdi odjavu"; „rani odlazak navodi noći koje se oslobađaju"; „dvostruki klik na Potvrdi odjavu šalje jedan zahtev"; „u sigurnom režimu Odjavi gosta radi, Prijavi gosta i Dodaj gosta su onemogućeni"; „Dodaj gosta onemogućeno kad je boravak pun"; „poruka koja nije poslata prikazuje razlog i dugme Pošalji ponovo"; „newKey se ne menja između ponovljenih pokušaja istog dijaloga".
- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija; mobilni prikaz od 375 px (akcije boravka su puna širina, bez horizontalnog skrola), naslov `<h1>` stranice ima `tabIndex={-1}`.
- [ ] **Step 4:** `ci.sh` → PASS.
- [ ] **Step 5:** Commit `Check guests in and out and manage stay guests from the reservation page`.

---

### Task 11: hotel-web: folio, plaćanja i dokumenti

**Files:**
- Create: `apps/hotel-web/src/app/folio/[stayId]/{layout.tsx,page.tsx}`, `apps/hotel-web/src/components/{folio-view.tsx,folio-view.test.tsx,document-view.tsx,document-view.test.tsx}`, `apps/hotel-web/src/app/dokumenti/[id]/page.tsx`
- Modify: `apps/hotel-web/src/lib/types.ts`, `apps/hotel-web/src/lib/messages.ts`, `apps/hotel-web/src/app/globals.css` (stil za štampu `@media print`)

**Interfaces:**
- Consumes: Task 4 (folio), Task 8 (dokumenti), `useRole` (`src/lib/use-role.ts`) za dugmad samo za owner/manager.
- Produces:
  - `/folio/[stayId]`: zaglavlje (rezervacija, gost, jedinica, datumi, status folija), tabela stavki (datum, opis, iznos; storno prikazan precrtano sa vezom na stavku), plaćanja, „Ukupno", „Plaćeno", „Saldo" (negativan saldo: „Gost ima kredit {iznos}"), „Očekivane noći" (`unpostedNights`). Akcije: „Dodaj zaduženje" (vrsta Usluga/Naknada, opis, iznos u dinarima sa dve decimale, PDV stopa iz podešavanja), „Naplati" (način Gotovina/Kartica/Prenos, iznos podrazumevano = saldo, referenca), „Vrati novac" (owner/manager, samo uz kredit), „Storniraj" na stavci i plaćanju (owner/manager, obavezan razlog), „Nefiskalni račun", „Predračun". Zatvoren folio: samo pregled i dokumenti.
  - Unos iznosa: `parseRsd(input: string): number | null` u `src/lib/format.ts` (prihvata `1.234,56`, `1234,56`, `1234`; odbija više od dve decimale i negativno) → minor jedinice. Nikad `parseFloat` nad iznosom.
  - `/dokumenti/[id]`: prikaz `DocumentContent` za štampu (A4 i 80 mm termalni preko `@media print`), sa jasno istaknutim „Ovo nije fiskalni račun.", PDV rekapitulacijom kad postoji i dugmetom „Štampaj" (`window.print()`).
  - Svaka akcija novca koristi `newKey()` po otvaranju dijaloga; ponovljen odgovor `200` se prikazuje isto kao `201`.
- [ ] **Step 1: Testovi:** `format.test.ts` za `parseRsd` („1.234,56 → 123456", „1234 → 123400", „0,005 → null", „-5 → null", „12,3 → 1230"); „saldo 20.000,00 je podrazumevani iznos naplate"; „dugmad Vrati novac i Storniraj ne postoje za recepcionara"; „idempotency_key_reused prikazuje poruku i ne zatvara dijalog"; „zatvoren folio nema dugmad za izmene"; „u sigurnom režimu Naplati radi, Dodaj zaduženje je onemogućeno"; „dokument prikazuje oznaku nefiskalnog računa i PDV tabelu"; „predračun označava očekivane noći".
- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija, 375 px: tabela stavki prelazi u listu kartica ispod 600 px; iznosi poravnati desno, `font-variant-numeric: tabular-nums`.
- [ ] **Step 4:** `ci.sh` → PASS.
- [ ] **Step 5:** Commit `Show the folio with charges, payments and printable documents`.

---

### Task 12: hotel-web: poslovni dan, podešavanja poslovanja i pravni profil

**Files:**
- Create: `apps/hotel-web/src/app/poslovni-dan/{layout.tsx,page.tsx,page.test.tsx}`, `apps/hotel-web/src/app/podesavanja/poslovanje/{page.tsx,page.test.tsx}`, `apps/hotel-web/src/app/podesavanja/pravni-profil/{page.tsx,page.test.tsx}`, `apps/hotel-web/src/components/business-day-badge.tsx`
- Modify: `apps/hotel-web/src/components/app-shell.tsx` (meni: „Poslovni dan", „Poslovanje", „Pravni profil"; `BusinessDayBadge` uz meni), `apps/hotel-web/src/lib/messages.ts`, `apps/hotel-web/src/components/app-shell.test.tsx`

**Interfaces:**
- Consumes: Task 3 i 6 (`GET /business-day`, `POST /business-day/close`, `GET /business-days`, `GET /business-days/:day`, `GET/PUT /settings/business`), Task 7 (`GET/PUT /legal-profile`).
- Produces:
  - `/poslovni-dan`: otvoreni dan (veliko), današnji datum, upozorenje kad `lagDays > 0` („Poslovni dan kasni {n} dana. Zatvorite dan {D.M.} da biste prijavljivali današnje goste."), `pending` brojevi, lista blokada (gost koji danas odlazi, sa linkom na rezervaciju), poslednja greška automatskog zatvaranja, dugme „Zatvori dan {D.M.}" sa potvrdom (dijalog navodi koliko noćenja će se knjižiti i koliko no-show), posle zatvaranja prikaz izveštaja; lista zatvorenih dana (poslednjih 30) sa otvaranjem izveštaja. Dugme je onemogućeno kad postoje blokade ili kad je otvoreni dan posle današnjeg.
  - `BusinessDayBadge`: „Poslovni dan: {D.M.}" u meniju; crvena oznaka kad `lagDays > 0`.
  - `/podesavanja/poslovanje` (owner/manager): vreme automatskog zatvaranja (prazno = ručno), naplata no-show (Bez naplate / Prva noć), PDV stopa smeštaja i dozvoljene stope za zaduženja (u procentima, šalju se kao bazni poeni).
  - `/podesavanja/pravni-profil` (owner/manager): vrsta lica menja obavezna polja (PIB i MB za pravno lice i preduzetnika, JMBG za fizičko lice), provera PIB-a i JMBG-a u pregledaču istim algoritmom kao API (kopija u `src/lib/legal-ids.ts` sa istim vektorima testa), maskiran JMBG ostaje maskiran dok se ne unese nov, kategorija smeštaja, broj rešenja o kategorizaciji, način fiskalizacije sa obaveštenjem `fiscalNotice` („Fiskalizacija još nije uključena; plaćanja se beleže bez fiskalnog računa."), lista `missing` kao upozorenje „Za račune nedostaje: …".
- [ ] **Step 1: Testovi:** „kašnjenje od 1 dana prikazuje upozorenje i oznaku u meniju"; „blokada prikazuje gosta sa linkom i onemogućava zatvaranje"; „zatvaranje šalje dan koji je prikazan i posle prikazuje izveštaj"; „alreadyClosed prikazuje sačuvan izveštaj bez greške"; „business_day_in_future prikazuje poruku"; „vreme 24:00 se ne šalje"; „pravno lice sa PIB 100002888 prikazuje grešku kontrolne cifre bez slanja"; „fizičko lice: polje JMBG prikazuje maskiranu vrednost i ne šalje je kao novu"; „recepcionar ne vidi Poslovanje ni Pravni profil u meniju".
- [ ] **Step 2:** `ci.sh` → FAIL.
- [ ] **Step 3:** Implementacija, 375 px.
- [ ] **Step 4:** `ci.sh` → PASS.
- [ ] **Step 5:** Commit `Add the business day screen and the business and legal settings`.

---

### Task 13: Završna provera licenci, ruta i dokumentacije

**Files:**
- Modify: `apps/hotel-api/test/licensed-routes.e2e-spec.ts` (samo ako nove rute nisu pokrivene automatski), `apps/hotel-api/test/manifest.spec.ts` (bez izmene manifesta: proverava da su `hotel.core` i `hotel.folio` jedini moduli novih akcija)
- Create: `apps/hotel-api/test/safe-mode-1b.e2e-spec.ts`
- Modify: `CLAUDE.md` (SMTP, pozadinski poslovi, poslovni dan na stagingu, smoke-1b), `docs/contracts/admin-panel.md` (napomena: 1b ne traži ništa od Admin Panela; `hotel.folio` stiže kao core modul)

**Interfaces:**
- `safe-mode-1b.e2e-spec.ts`: jedna tabela svih ruta 1b × očekivan ishod u sigurnom režimu, izvedena iz `discoverRoutes(app)` (`test/routes.ts`), sa nezavisnim spiskom očekivanja u testu:
  ```ts
  const ALLOWED_IN_SAFE_MODE = new Set([
    'GET /guests', 'GET /stays/:id/folio', 'POST /stays/:id/folio/payments', 'POST /stays/:id/folio/refunds',
    'POST /stays/:id/folio/documents', 'GET /stays/:id/folio/documents', 'GET /folio-documents/:id',
    'GET /stays/:id/check-out-preview', 'POST /stays/:id/check-out', 'GET /business-day', 'POST /business-day/close',
    'GET /business-days', 'GET /business-days/:day', 'GET /settings/business', 'GET /legal-profile',
    'GET /reservations/:id/messages',
  ]);
  ```
  Test prolazi kroz sve rute čije akcije pripadaju 1b (`guest.*`, `stay.check_*`, `folio.*`, `business_day.*`, `settings.*`, `legal_profile.*`, `message.*`), proverava da je ruta u listi tačno kad joj je akcija u `SAFE_MODE_ALLOWED`, i da broj takvih ruta nije manji od 25 (pod-test protiv prazne liste). Rute 1a ostaju pokrivene postojećim testovima.
- [ ] **Step 1:** Napiši test; `ci.sh` → FAIL ako je neka ruta u neskladu (inače PASS odmah: tada probom brisanjem dokaži da hvata: ukloni `folio.pay` iz `SAFE_MODE_ALLOWED` → mora pasti sa imenom rute; vrati).
- [ ] **Step 2:** Ažuriraj `CLAUDE.md`: (a) SMTP promenljive u `hotel.env` dopisuje vlasnik (vrednosti se ne ispisuju), bez njih mejlovi ostaju „Nije poslato: SMTP nije podešen."; (b) `hotel-api` sam pokreće dispečer i automatsko zatvaranje dana; (c) posle deploy-a 1b poslovni dan je dan migracije; prvo zatvaranje prevodi stare `expected` boravke u no-show; (d) komanda za `smoke-1b` (Task 14).
- [ ] **Step 3:** `ci.sh` → PASS.
- [ ] **Step 4:** Commit `Pin the 1b safe-mode routes and document the new staging behaviour`.

---

### Task 14: smoke-1b na stagingu

**Files:**
- Create: `scripts/smoke-1b.mjs`
- Modify: `apps/hotel-api/test/scripts.e2e-spec.ts` (smoke protiv test aplikacije, kao za `smoke-1a`)

**Interfaces:**
- Pokretanje: `HOTEL_SMOKE_PASSWORD=… node scripts/smoke-1b.mjs --api http://192.168.1.199:4200 --email <vlasnik> (--totp <6 cifara> | --totp-file ~/owner-totp.txt) [--allow-close] [--mail-to <adresa>]`.
- Radi samo dok je Turnstile isključen: prijava ne šalje token; `403 captcha_failed` → `FAIL sign-in: Turnstile je uključen; smoke radi samo bez TURNSTILE_* ključeva`.
- Koraci (svaki `OK`, `SKIP <zašto>` ili prvi `FAIL` i exit 1), nastavljivo iz stanja API-ja:
  1. `health`; 2. prijava vlasnika (TOTP iz `--totp` ili `--totp-file`; URI se nikad ne ispisuje); 3. `GET /licence`: stanje `VALID` ili `GRACE`, moduli sadrže `hotel.core` i `hotel.folio`.
  4. Poslovni dan: dok je otvoreni dan pre današnjeg, zatvara se dan po dan **samo uz `--allow-close`** (bez njega `FAIL business day: poslovni dan {D} kasni; pokrenite sa --allow-close`); svaki zatvoren dan ispisuje broj noćenja i no-show (to su pravi podaci objekta). Blokada (`close_blocked`) se ispisuje sa brojevima rezervacija i prekida.
  5. Ostaci prethodnog neuspelog pokretanja: boravci gosta „Smoke Test 1b" u statusu `in_house` se izmiruju (naplata salda, ili povraćaj kredita) i odjavljuju.
  6. Tip `SMOKE` i plan `SMOKE` (iz smoke-1a; ako ne postoje, prave se kao u smoke-1a) i cene za `[B, B + 30)`.
  7. Rezervacija `[B, B + 1)` na slobodnu jedinicu `S-1`/`S-2`, nosilac „Smoke Test 1b" (e-adresa samo uz `--mail-to`).
  8. Dodatni gost; 9. check-in; 10. zaduženje „Smoke mini bar" 500,00; 11. naplata gotovinom 500,00.
  12. Zatvaranje dana `B` uz `--allow-close` kad je `B ≤ danas`; kad je `B > danas` (drugo pokretanje istog dana) `SKIP close: poslovni dan je već sutrašnji`.
  13. Naplata salda karticom (noćenje); 14. nefiskalni račun (provera oznake i `dueMinor = 0`); 15. check-out (posle zatvaranja normalan odlazak, bez zatvaranja odlazak na dan dolaska; oba knjiže tačno jednu noć).
  16. Provera: folio `closed`, saldo 0, tačno jedna stavka smeštaja; uz `--mail-to` poruka potvrde je `sent` ili prikazuje razlog (`SKIP` sa razlogom kad SMTP nije podešen).
- Ostavlja prave podatke: rezervacije i folije gosta „Smoke Test 1b", zatvorene poslovne dane, nefiskalne račune `N-…`. To se navodi u zaglavlju skripte i u izveštaju.
- [ ] **Step 1:** Test u `scripts.e2e-spec.ts`: smoke protiv test aplikacije sa lažnim satom (`--allow-close`) daje samo `OK` linije i exit 0; drugo pokretanje istog dana daje `SKIP close` i exit 0; bez `--allow-close` uz poslovni dan koji kasni daje `FAIL business day` i exit 1.
- [ ] **Step 2:** `ci.sh` → FAIL, implementacija, `ci.sh` → PASS.
- [ ] **Step 3:** Commit `Add the resumable phase 1b smoke test`.
- [ ] **Step 4 (korisnik):** `bash infrastructure/nas/deploy.sh` (podiže `api` i `web` sa migracijama `0008`–`0013`; baze se ne prave ponovo). Očekivano: `hotel-api-claude` i `hotel-web-claude` healthy; `docker logs hotel-api-claude` bez greške migracije.
- [ ] **Step 5 (korisnik, opciono):** SMTP ključevi u `/volume1/ci/hotel/hotel.env` i ponovo `deploy.sh`.
- [ ] **Step 6 (korisnik):** `smoke-1b.mjs … --allow-close` (TOTP vlasnika). Pre toga korisnik zna: zatvaranje dana je trajno i prevodi stare `expected` boravke Demo Hotela u no-show.
- [ ] **Step 7 (korisnik, telefon i računar, `http://192.168.1.199:4201`):** prijava gosta sa stranice rezervacije, folio sa zaduženjem i naplatom, nefiskalni račun i štampa, zatvaranje dana sa ekrana „Poslovni dan", odjava, pravni profil, back-to-top na dugačkoj stranici (Task 1, Step 5). Rezultat (snimci ekrana na 375 px) ide u izveštaj vlasniku.

---

## Otvorena pitanja (sa predloženim podrazumevanim rešenjem)

1. **`business_day.close` u sigurnom režimu.** Spec §9 ga ne navodi ni kao dozvoljen ni kao blokiran. Bez njega se noćenja gostiju u kući ne knjiže i folio se ne može izmiriti, pa check-out (dozvoljen) gubi smisao. **Podrazumevano:** dozvoljeno (Task 3). Cena ako je pogrešno: jedan red u `SAFE_MODE_ALLOWED` i jedan red u testu Taska 13.
2. **Plaćanje za profil koji traži fiskalizaciju (§4.2: „ne zatvara plaćanja").** `@platform/fiscal-rs` ne postoji, a smoke-1a je Demo Hotel podesio kao `legal_entity`. **Podrazumevano:** u 1b plaćanje se beleži sa `fiscal_document_id = NULL`, dokument nosi „Ovo nije fiskalni račun.", a pravni profil i folio prikazuju upozorenje `fiscalNotice`; tvrda blokada stiže u 1c sa fiskalizacijom. Bez ove odluke check-out u smoke-1b ne može da se završi.
3. **Kontrolna cifra matičnog broja (MB).** Algoritam koji je proveren prolazi za neke stvarne MB-ove, a za druge ne. **Podrazumevano:** 1b proverava samo 8 cifara; kontrola se dodaje kad knjigovođa ili zvanična dokumentacija potvrdi algoritam.
