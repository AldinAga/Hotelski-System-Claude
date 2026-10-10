# Hotelski sistem: dizajn

**Datum:** 2026-10-10
**Status:** Dizajn odobren u razgovoru sekciju po sekciju; pisani spec čeka pregled
**Zavisi od:** Admin Panel i `platform-kit` — spec `docs/superpowers/specs/2026-10-10-licensing-platform-design.md` u repou Ugostiteljskog POS-a (grana `docs/licensing-platform-spec`); ovaj dokument dopunjuje i zamenjuje njegov §13 „okvir hotela"
**Makete:** `.superpowers/brainstorm/` (lokalno, nisu u git-u): teme sajta (`teme-premium-v4.html`), uređivač, galerija i zahtevi (`urednik-i-zahtevi.html`)

---

## 1. Cilj

Komercijalni softver za smeštaj koji se prodaje kao pretplata kroz Admin Panel: od stana na dan i prenoćišta sa nekoliko jedinica do hotela sa preko 100 soba. Svaki deo je modul koji se uključuje i isključuje iz Admin Panela.

**Uspeh znači:**

1. Mali objekat (stan, domaća radinost) i hotel od 100+ soba rade na istom softveru, razlikuju se samo po modulima, limitima i pravnom profilu.
2. Hotel dobija profesionalan sajt bez programiranja: podaci iz podešavanja, kategorizovana galerija, teme i uređivač blokova.
3. Gost rezerviše sa sajta, widgeta ili WordPress sajta; recepcija potvrđuje; raspoloživost se odmah zatvara na Booking.com i ostalim kanalima.
4. Srpske zakonske obaveze (e-Turista, boravišna taksa, fiskalizacija gde je obavezna, SEF) rade po pravnom profilu objekta.
5. Instalacija radi bez interneta na osnovu važeće licence, a sajt radi i kad hotel nema internet.

## 2. Odluke

| Tema | Odluka |
|---|---|
| Proizvod | Komercijalni, pretplata; ključ proizvoda u Admin Panelu: `hotel` |
| Repo | Zaseban: `D:\Claude\Hotelski system` |
| Instalacija | Jedan objekat po instalaciji (server u hotelu ili VPS); svaka poslovna tabela nosi `property_id` za kasnije povezivanje više objekata istog vlasnika. Mali objekti i stanovi mogu biti `hosted` instalacija na VPS-u vlasnika softvera |
| V1 obim | Recepcija i folio sa srpskim obavezama, housekeeping i održavanje, veza sa POS-om, online prodaja (sajt, booking engine, kanali), stan na dan |
| OTA | Preko channel managera iza adaptera u hubu; sopstvene direktne veze kasnije kao zamena adaptera |
| Istek licence | Siguran režim |
| Sajt | Servira ga `hotel-hub` na VPS-u; 3 teme (Grand, Atelier, Retreat) + uređivač blokova i stranica; SR i EN, proširivo |
| Rezervacija sa sajta | Zahtev → ručna potvrda recepcije (podrazumevano) → rezervacija → zatvaranje na kanalima; trenutna rezervacija je opcija |
| Spoljni sajtovi | Iframe/JS widget, javni REST API, WordPress plugin; servira hub ili instalacija sa javnom adresom |
| Garancija | Plaćanje u hotelu, link za karticu, predračun, NBS IPS QR; hotel bira koje nudi |
| Pravni oblici | Pravna lica, preduzetnici, fizička lica (domaća radinost) |
| Stan na dan | Vlasnik sa 1–5 jedinica i agencija koja upravlja tuđim stanovima |
| Stack | TypeScript, NestJS, PostgreSQL 16 + Drizzle, Next.js, Redis + BullMQ, pnpm + Turbo; paketi iz `platform-kit` |

**Izvan obima:** tržišta van Srbije; Kubernetes; više objekata u jednoj instalaciji (model spreman, funkcija nije); dinamičko određivanje cena; slobodno pozicioniranje elemenata na sajtu (Wix-stil); sopstvene direktne OTA veze.

## 3. Arhitektura

| Runtime | Gde | Odgovornost |
|---|---|---|
| `hotel-api` | instalacija | NestJS modularni monolit; svi poslovni moduli; provera licence iz `@platform/licensing` po akciji |
| `hotel-web` | instalacija | Next.js: recepcija, kalendar, housekeeping, uređivač sajta i galerija, backoffice, izveštaji; PWA za domaćina i čistačice |
| `hotel-worker` | instalacija | Noćni audit, outbox (e-Turista, fiskal, poruke, brave), objava sajta, sinhronizacija sa hubom i Admin Panelom, backup |
| `hotel-device-agent` | instalacija (opciono) | Enkoderi kartica, štampači, L-PFR; ne postoji u VPS i hosted instalaciji |
| PostgreSQL | instalacija | Lokalna baza |
| `hotel-hub` | VPS vlasnika softvera (`hosted`, multi-tenant) | Sajtovi hotela, booking engine, widget i javni API, stranica za plaćanje karticom, guest portal, adapter za channel manager |

**Pravilo veza:** instalacija sama otvara sve veze (prema Admin Panelu za licencu, heartbeat i ažuriranja; prema hubu preko WebSocketa). Hub i Admin Panel nikad ne zovu instalaciju. POS se povezuje sa `hotel-api` preko lokalne mreže.

Hub je zaseban runtime u istom repou, sa sopstvenom bazom; ne čita bazu nijedne instalacije. Licencu klijenta proverava preko Admin Panela (`/v1/licenses/check`).

## 4. Moduli, limiti i paketi

Ključevi su ugovor sa Admin Panelom i objavljuju se u manifestu proizvoda.

### 4.1 Jezgro (uvek uključeno dok pretplata važi)

| Ključ | Sadržaj |
|---|---|
| `hotel.core` | Objekat i pravni profil, jedinice i tipovi, osnovni cenovnik, rezervacije, kalendar, check-in/out, gosti, korisnici i uloge, audit, email potvrde |
| `hotel.folio` | Folio, plaćanja, nefiskalni računi i predračuni, IPS QR, avansi, noćni audit (automatski ili ručni) |
| `hotel.eturista` | Prijava i odjava gostiju, boravišna taksa (po gostu ili paušalno, po profilu) |

### 4.2 Dodaci

| Ključ | Sadržaj | Zavisi od |
|---|---|---|
| `hotel.fiscal_rs` | Fiskalizacija; zakonski obavezna za profile koji je zahtevaju | folio |
| `hotel.card_payments` | Link za plaćanje karticom | folio |
| `hotel.rates_advanced` | Sezone, restrikcije, pansioni, paketi, izvedeni planovi | core |
| `hotel.housekeeping` | Status jedinica, zadaci, čišćenje posle odlaska, spoljne čistačice preko linka, foto-potvrda, prijava štete i zaliha | core |
| `hotel.maintenance` | Kvarovi, jedinice van funkcije | core |
| `hotel.b2b` | Firme, agencije, SEF | folio |
| `hotel.booking_engine` | Zahtevi i rezervacije sa sajta, widgeta, API-ja i WordPress plugina; red za potvrdu | core |
| `hotel.website` | Sajt: teme, uređivač, galerija, jezici, domen | booking_engine |
| `hotel.guest_portal` | Online check-in, digitalni vodič, otkrivanje koda ulaza | core |
| `hotel.messaging` | Automatske poruke po događaju; email, SMS, WhatsApp | core |
| `hotel.channels` | Channel manager | core |
| `hotel.pos_link` | Veza sa Ugostiteljskim POS-om | folio |
| `hotel.door_locks` | Brave i pristup: enkoderi kartica, pametne brave, kutije za ključ | core |
| `hotel.rentals` | Režim stan na dan: jedinice na različitim adresama, kućni red, naknade, depozit, PWA za domaćina | core |
| `hotel.owners` | Vlasnici, ugovori, mesečni obračun, portal za vlasnika | folio, rentals |

Kasnije (van V1): `groups`, `analytics`, `events`, `spa`, `multi_property`.

**Zakonski obavezni moduli:** pravni profil određuje koji moduli moraju biti uključeni (npr. `fiscal_rs` za pravno lice). Ako nedostaju, instalacija ne zatvara plaćanja i prikazuje razlog; Admin Panel pri sastavljanju pretplate upozorava na neusklađenost (manifest nosi `required_by_profile`).

### 4.3 Limiti

`rooms` (jedinice: sobe ili stanovi), `users`, `devices`, `lock_encoders`, `website_languages`, `gallery_storage_gb`, `owners`, `installations`.

### 4.4 Paketi (predlog; cene i granice se podešavaju u Admin Panelu)

| Paket | Za koga | Sadržaj |
|---|---|---|
| Stan | Vlasnik, 1–5 jedinica | Jezgro + rentals + guest_portal + messaging + channels + door_locks |
| Agencija | Upravljanje tuđim stanovima | Stan + owners + housekeeping + booking_engine + website |
| Mini | Domaća radinost, do 10 soba | Jezgro + booking_engine + website + channels |
| Mali | Prenoćišta, moteli, do 30 soba | Mini + fiscal_rs + card_payments + housekeeping |
| Hotel | Do 100 soba | Mali + rates_advanced + maintenance + b2b + pos_link + guest_portal + messaging |
| Pro | Bez ograničenja | Hotel + door_locks + kasniji moduli |
| Custom | Po dogovoru | Proizvoljno |

### 4.5 Isključivanje

Isključenje modula nikad ne briše podatke i ne prekida otvorene boravke. Isključen `website`: sajt prikazuje neutralnu stranicu „privremeno nedostupno"; isključen `booking_engine`: widget i API ne primaju zahteve; isključen `channels`: hub prestaje sa sinhronizacijom, postojeće rezervacije ostaju; isključen `pos_link`: POS ne nudi plaćanje na sobu. Interfejs prikazuje samo uključene module; mali objekti dobijaju jednostavan režim (automatski noćni audit, spojene uloge, kalendar bez tipova).

## 5. Model podataka (`hotel-api`)

Svaka poslovna tabela nosi `property_id`. Novac: celobrojne minor jedinice (`@platform/money`).

### 5.1 Objekat, pravni profil, vlasnici

- `property`: naziv, vremenska zona, valuta (RSD), jezici, podrazumevana opština.
- `legal_profile`: tip (`legal_entity` | `entrepreneur` | `natural_person`), PIB, matični broj ili JMBG, PDV obveznik, fiskalizacija obavezna.
- `owner` (owners): vlasnik, sopstveni pravni profil, ugovor (provizija %, fiksni iznos, troškovi na teret vlasnika).

### 5.2 Jedinice i raspoloživost

- `unit_type` (opciono): kod, naziv, kapacitet, kreveti, opis po jeziku.
- `unit`: broj ili naziv, `unit_type_id` (može biti prazno), adresa i koordinate, opština, registarski broj objekta za e-Turista, `owner_id`, obveznik prijave (`owner` | `operator`), status čistoće (`clean` | `dirty` | `inspected`), aktivna.
- `unit_block`: jedinica, `daterange`, razlog (`maintenance` | `owner_use` | `other`).
- `inventory_day` (tip ili jedinica bez tipa, datum): `total`, `sold`, `blocked` — jedini izvor raspoloživosti.

### 5.3 Cene i naknade

- `rate_plan`: pansion (RO | BB | HB | FB), politika otkazivanja, `derived_from_id` + pravilo (% ili iznos), popusti za 7 i 30 noći.
- `rate_day` (plan, tip ili jedinica, datum): cena, `min_stay`, `cta`, `ctd`, `closed`.
- `fee`: čišćenje, doplata po osobi, depozit, ostalo; po boravku, noći ili osobi.

### 5.4 Rezervacije i boravci

- `reservation`: broj, izvor (`front_desk` | `phone` | `website` | `widget` | `api` | `ota`), `channel` + `external_id` (jedinstven par), nosilac, `company_id`, status (`requested` | `confirmed` | `cancelled` | `no_show`), garancija, `version`.
- `booking_request`: podaci gosta, tražena jedinica ili tip, datumi, gosti, napomena, jezik, izvor, status (`new` | `confirmed` | `offered_alternative` | `declined` | `expired`), `reservation_id`, ključ idempotentnosti iz huba.
- `stay`: rezervacija, tip, jedinica (prazno do dodele), `arrival`, `departure` (lokalni datumi), odrasli, deca, plan, status (`expected` | `in_house` | `checked_out` | `cancelled`).
- `stay_night`: snimak cene, plana i poreskog profila po noći.
- `stay_guest`: gost, primarni, `eturista_status` (`pending` | `sent` | `failed` | `not_required`), reference prijave i odjave.
- `guest`: ime, prezime, pol, datum rođenja, državljanstvo, vrsta i broj dokumenta, adresa, kontakt, jezik; fotografija dokumenta šifrovana, sa rokom brisanja iz podešavanja.
- `access_code`: boravak, jedinica, kod ili ključ kartice, `valid_from`, `valid_until`, status kod proizvođača.

### 5.5 Novac

- `folio`, `folio_line`: tip (`accommodation` | `tourist_tax` | `fee` | `pos` | `service` | `deposit` | `correction`), iznos, poreski profil, poslovni datum, izvor (`source_type`, `source_id`), `reverses_line_id`.
- `payment`: način (`cash` | `card` | `card_link` | `ips_qr` | `transfer` | `advance`), iznos, `fiscal_document_id`, ključ idempotentnosti.
- Samo dodavanje: stavke i plaćanja se ne menjaju i ne brišu; ispravka je nova stavka sa `reverses_line_id` i razlogom u auditu.
- Porezi i boravišna taksa su konfiguracija po opštini, kategoriji gosta i profilu.
- `owner_statement`: period, vlasnik, prihod po kanalu, provizije OTA, čišćenje, troškovi, provizija agencije, za isplatu; zaključan kad se izda.

### 5.6 Poslovni dan i noćni audit

`business_day` (`open` | `closing` | `closed`). Noćni audit u jednoj transakciji knjiži noćenja i taksu za boravke `in_house` i obrađuje no-show po politici; za male objekte radi automatski u podešeno vreme. Blokira zatvaranje: neodjavljen boravak sa prošlim datumom odlaska, neuspelo knjiženje. Upozorenja: neposlate prijave na e-Turista, fiskalni računi u redu.

### 5.7 Zaštita od overbookinga

- Dodela jedinice: `EXCLUDE USING gist (unit_id WITH =, daterange(arrival, departure) WITH &&) WHERE unit_id IS NOT NULL AND status IN ('expected','in_house')`, uz analognu proveru protiv `unit_block`.
- Prodaja po tipu: transakcija sa `SELECT … FOR UPDATE` nad `inventory_day` za sve noći; odbija se ako `sold + blocked + 1 > total`.
- Recepcija, potvrda zahteva sa sajta i OTA rezervacija pozivaju istu funkciju.

## 6. Sajt i hub

### 6.1 Uređivanje i objava

- Uređivač u `hotel-web`: stranica je niz blokova (naslovna slika ili video, priča, sobe, galerija, restoran, ponude, utisci, lokacija i kontakt, FAQ, slobodan tekst); blokovi se dodaju, prevlače, sakrivaju i podešavaju; dodatne stranice. Tema određuje izgled, blok sadržaj. Pregled za računar, tablet i telefon.
- Sobe, kontakt, lokacija i podaci objekta se pune automatski iz podešavanja.
- Teme V1: **Grand** (klasičan luksuz), **Atelier** (savremeni dizajn hotel), **Retreat** (priroda i tišina); hotel menja logo, boje, fontove i redosled blokova. Zajedničko: mobilni prikaz na prvom mestu sa stalnim dugmetom za rezervaciju, video po želji, nenametljive animacije, SEO i schema.org, kolačići samo nužni dok gost ne pristane.
- Galerija: kategorije koje hotel definiše; fotografija može biti vezana za tip ili jedinicu; naslovna fotografija; obavezan opis; automatske optimizovane veličine (WebP).
- Jezici: SR i EN na startu; dodatni jezik se uključuje kad je sadržaj preveden (limit `website_languages`); nepreveden sadržaj pada na engleski.
- „Objavi" pravi verzionisan paket (sadržaj po jeziku + slike adresirane po hešu); `hotel-worker` ga šalje hubu i šalje samo nove slike. Hub čuva verzije; povratak na prethodnu je jedan klik.

### 6.2 Serviranje

- `hotel-hub` (Next.js, multi-tenant) pre-renderuje sajt po hotelu i briše keš pri objavi.
- Domen: hotel unese domen i podesi DNS; hub proveri da zapis pokazuje na njega pre izdavanja Let's Encrypt sertifikata. Do tada sajt radi na poddomenu platforme.
- Slike u S3-kompatibilnom skladištu (MinIO); CDN opciono.

### 6.3 Raspoloživost i zahtevi

- Hotel šalje hubu ARI delte sa monotonom revizijom (isti tok kao prema channel manageru); hub odbacuje zastarele revizije i odgovara na pretrage iz svoje kopije.
- Režim zahteva (podrazumevano): hub trajno čuva zahtev, gostu odmah šalje „zahtev primljen", isporučuje zahtev hotelu preko WebSocketa dok ne dobije ACK. Zahtev ne drži jedinicu.
- Recepcija: lista zahteva sa vremenom čekanja i proverom da li je jedinica i dalje slobodna; akcije Potvrdi, Ponudi drugu jedinicu ili datum, Odbij; izbor garancije koja se šalje gostu. Potvrda prolazi kroz §5.7 i pravi rezervaciju; raspoloživost se zatvara na svim kanalima.
- Neobrađen zahtev posle podesivog roka (podrazumevano 2 h): gost dobija automatsku poruku, menadžer upozorenje; posle drugog roka zahtev ističe.
- Trenutna rezervacija (opcija): dozvoljena samo dok su ARI podaci u hubu mlađi od praga (podrazumevano 15 min); inače se automatski prelazi u režim zahteva.

### 6.4 Spoljni sajtovi

- Isti javni endpointi za widget (`widget.js`, iframe), REST API (raspoloživost, slanje zahteva) i WordPress plugin (shortcode i Gutenberg blok koji koriste widget i API).
- Zaštita: javni ključ hotela, lista dozvoljenih domena (CORS), rate limit, Cloudflare Turnstile.
- Hotel sa javnom adresom (VPS) može iste endpointe servirati direktno iz `hotel-api` kad je `public_base_url` podešen.

### 6.5 Plaćanja i guest portal na hubu

- IPS QR generiše hotel po NBS standardu (poziv na broj = broj rezervacije).
- Stranica za plaćanje karticom je na hubu (gateway traži javni povratni poziv koji se proverava potpisom); rezultat stiže hotelu kao zahtev i knjiži se kao avans, uz fiskalizaciju gde je obavezna. Kartični podaci nikad ne prolaze kroz sistem.
- Guest portal (online check-in, vodič, kod ulaza) je na hubu. Lični podaci i fotografije dokumenata stoje u hubu samo dok ih hotel ne preuzme, zatim se brišu iz huba (ZZPL).

## 7. Integracije

Zajednički obrazac: outbox sa ključem idempotentnosti, ponavljanje sa backoff-om, svaki pokušaj se pamti, neuspeh je vidljiv u aplikaciji sa razlogom; svaki provider ima pravu i Noop implementaciju, a Noop beleži iskren neuspeh.

| Integracija | Rad | Kad ne radi |
|---|---|---|
| e-Turista | Prijava pri check-inu, odjava pri check-outu, po gostu i jedinici; obveznik iz podešavanja jedinice | Greška sa poljem i razlogom, ponovno slanje; rezerva: izvoz za ručni unos uz status po gostu |
| Fiskalizacija | `@platform/fiscal-rs`: avansni, konačni, storno; ESIR/L-PFR | Plaćanje evidentirano, dokument u redu, upozorenje |
| Channel manager | Adapter u hubu; ARI ka kanalima; rezervacije, izmene i otkazi kroz §5.7; mapiranje jedinica i planova u aplikaciji | Hotel offline: poslednje poznato stanje; posle praga (podrazumevano 30 min) automatsko zatvaranje prodaje; overbooking pri ponovnom spajanju označen recepciji |
| Kartice | Adapter za srpske gatewaye | Neuspeh ne potvrđuje garanciju; novi link |
| IPS QR | NBS standard; potvrda ručno ili uvozom izvoda | Nema spoljne zavisnosti |
| SEF | e-Fakture firmama | Noop: „SEF nije konfigurisan" |
| POS | Lokalni API sa sparenim uređajem: `in-house` pretraga, knjiženje na folio (ključ = ID POS računa), pravo na pansion; licenca na obe strane (`hotel.pos_link`, `pos.hotel_link`) | POS ne nudi plaćanje na sobu |
| Brave i pristup | Adapter po proizvođaču; enkoderi preko device-agenta, pametne brave preko oblaka proizvođača; kod pri potvrdi plaćanja ili prijave, brisanje posle odlaska | Upozorenje i rezervni kod |
| Poruke | Email, SMS, WhatsApp; šabloni po događaju i jeziku | Neposlato vidljivo sa razlogom; ručno ponovno slanje |

## 8. Stan na dan

- Režim `rentals`: jedinice na različitim adresama, mapa, kućni red, oprema, naknade (čišćenje, doplata po osobi), popusti za duži boravak, depozit (gotovina ili rezervacija sredstava na kartici).
- PWA za domaćina: kalendar, dolasci i odlasci, zahtevi, poruke, status čišćenja i kodova.
- Tok gosta: rezervacija (kanal ili sajt) → automatska poruka sa linkom za online check-in → gost unosi podatke ili slika dokument, prihvata kućni red, plaća → prijava na e-Turista → kod ulaza se kreira i šalje na dan dolaska → poruka pri odlasku i molba za recenziju → zadatak čišćenja spoljnoj čistačici.
- Agencija: obračun po vlasniku i periodu, PDF, evidencija isplata, portal za vlasnika (zauzetost, prihod, blokiranje datuma za lično korišćenje).
- Obveznik računa, prijave i takse podešava se po jedinici (`owner` ili `operator`).

## 9. Rad i isporuka

- **Instalacija:** Docker Compose; skripte za Linux, Windows, Synology; čarobnjak za aktivaciju kodom iz Admin Panela. Minimum mala instalacija: 2 jezgra, 4 GB RAM, SSD; 100+ soba: 4 jezgra, 8 GB RAM.
- **Hosted:** stanovi i mali objekti mogu raditi kao `hosted` instalacija na VPS-u vlasnika softvera (izolovana instalacija po klijentu).
- **Backup:** dnevni šifrovani `pg_dump` i kopija slika, rotacija 7 dnevnih i 4 nedeljna, opciona kopija van lokacije; datum poslednjeg uspešnog backupa u heartbeatu.
- **Ažuriranja:** ciljnu verziju postavlja Admin Panel, primenjuje updater hotela; backup pre migracije; neuspeh vraća prethodni image i backup.
- **Siguran režim:** dozvoljeno pregled, check-out, odjava na e-Turista, naplata i fiskalizacija otvorenih folija, izvoz; blokirano nove rezervacije, check-in, izmene cena, dodatni moduli; sajt prikazuje „privremeno nedostupno". Lista dozvoljenih akcija je u kodu (`safe_mode_allowed`).
- **Bezbednost:** prijava sa ulogama; obavezan TOTP za menadžere; audit svake promene; lični podaci gostiju šifrovani u mirovanju gde je osetljivo (dokumenti); rok čuvanja podesiv.

## 10. Testiranje

| Nivo | Šta pokriva |
|---|---|
| Unit | Cene, popusti, naknade, takse po profilu, noćni audit, storno, obračun vlasniku, zakonski obavezni moduli, siguran režim |
| Pravi PostgreSQL | Ograničenje isključivanja; paralelna prodaja iz recepcije, sajta i OTA; idempotentnost POS knjiženja i zahteva iz huba |
| Ugovorni | Hub ↔ hotel protokol (ARI, zahtevi, ACK); adapteri protiv snimljenih odgovora; manifest proizvoda protiv Admin Panela |
| E2E (Playwright) | Zahtev sa sajta → potvrda → zatvaranje na kanalima → online check-in → kod brave → POS račun na sobu → noćni audit → check-out → fiskalni račun |
| Synology | Čista instalacija, nadogradnja, vraćanje iz backupa, aktivacija i istek, rad bez WAN-a |

Test koji tvrdi da filter, guard ili provera radi dokazuje se brisanjem te provere (test mora pasti). Konkurentni testovi rade samo na pravom PostgreSQL-u.

## 11. Faze (svaka faza dobija svoj implementacioni plan)

Preduslovi: Admin Panel faze 0–1 i `fiscal-rs` (faza 5) iz spec-a platforme.

1. **Jezgro:** jedinice, cene, rezervacije, folio, poslovni dan, e-Turista, fiskalizacija, pravni profili, instalacija i aktivacija.
2. **Operativa:** housekeeping (spoljne čistačice), održavanje, POS veza, b2b i SEF.
3. **Hub i online:** objava sajta, teme i uređivač, galerija, booking engine, widget, API i WordPress plugin, kartice i IPS, guest portal.
4. **Kanali:** adapter za channel manager.
5. **Stan na dan:** rentals, poruke, brave i pristup, owners i portal za vlasnika.

## 12. Otvorena pitanja (ne blokiraju fazu 1)

1. Izbor channel managera (otvoren API, sertifikacije, cena po objektu) — pre faze 4.
2. e-Turista: uslovi API pristupa za proizvođače softvera — pre faze 1 (određuje da li je rezerva sa izvozom potrebna odmah).
3. Payment gateway za kartice — pre faze 3.
4. Proizvođači pametnih brava i enkodera koje prvo podržavamo — pre faze 5.
5. Pravno: u čije ime agencija izdaje račun za stan vlasnika fizičkog lica i ko je obveznik prijave i takse — potvrditi sa knjigovođom pre faze 5; softver podržava oba podešavanja.
6. WhatsApp: Business API provider — pre faze 5.
