# Ugovor hotel ↔ Centralni Admin Panel

Admin Panel (`D:\Claude\Admin Panel`, staging API `http://192.168.1.199:4100`, UI `:3100`) je za hotel samo
spoljni servis. Hotel koristi isključivo javne `/v1/*` rute i `@platform/licensing`; nikad ne čita bazu Admin
Panela. Sve što hotel traži, a Admin Panel nema, upisuje se ovde kao **zahtev** i radi se kao zaseban zadatak u
Admin Panel repou, unazad kompatibilan za POS, samo uz odobrenje korisnika (CLAUDE.md).

Stanje ugovora: proverene rute u Admin Panel repou (samo čitanje) 2026-10-28; strana hotela je
`apps/hotel-api/src/licensing/central-admin.client.ts` i `scripts/publish-manifest.mjs`.

## Podešavanje

| Promenljiva | Značenje |
|---|---|
| `CENTRAL_ADMIN_URL` | Osnovni URL API-ja (staging `http://192.168.1.199:4100`). Bez njega aktivacija daje 503 `licensing_not_configured`, a aktivirana instalacija ne šalje heartbeat (API to jednom loguje pri pokretanju). |
| `CENTRAL_ADMIN_ALLOW_HTTP` | `true` dozvoljava plain http (samo LAN staging). |
| `HOTEL_ROOT_KEYSET` | Izlaz `GET /v1/keys` (JSON ili base64), zakucan pri instalaciji: sidro poverenja. Ne čita se iz baze. |
| `HOTEL_SECRET_KEY` | 32 bajta, base64url; šifruje privatni ključ instalacije u bazi. Bez njega (ili neispravan) nema potpisanih zahteva; API to jednom loguje pri pokretanju. |
| `HOTEL_PUBLISHER_TOKEN` | Servisni token `product_publisher`, samo u okruženju pri objavi manifesta; nikad u repou. |

Svi pozivi hotela idu sa `redirect: 'error'` (3xx ne prenosi aktivacioni kod ni potpise na drugu adresu),
`accept: application/json`, telo `application/json`, i vremenskim ograničenjem.

## Rute koje hotel koristi

### `POST /v1/installations/activate` (javna, kod je akreditiv)

- Zahtev: `{ "code": "<aktivacioni kod>", "publicKey": "<base64url 32 bajta Ed25519 javnog ključa>" }`.
  Hotel pravi par ključeva lokalno; privatni ključ se čuva šifrovan (`HOTEL_SECRET_KEY`).
- Odgovor 200: `{ installationId, license: <potpisan envelope>, keySet: <potpisan key set> }`.
- Kod je jednokratan: ponovna aktivacija istim kodom je odbijena. Admin Panel ograničava pokušaje po IP-u.
- Odbijanje 4xx sa `{ code }` hotel vraća kao `422 activation_refused` sa `parentCode` i `parentStatus`; mrežna greška ili
  5xx je `503 central_admin_unavailable` (kod je verovatno još važeći).
- Hotel proverava `product === 'hotel'` u licenci, i lanac ključeva od `HOTEL_ROOT_KEYSET` (vidi `/v1/keys`).

### `GET /v1/license` (potpisan zahtev)

- `If-None-Match: "<revizija koju hotel drži>"` → `304` ako se nije promenila; inače `200` sa envelope-om i
  `ETag: "<revizija>"`. Admin Panel može da obnovi licencu pri ovom pozivu (zakup koji ističe).
- Hotel envelope proverava sa `@platform/licensing` pre nego što ga sačuva.

### `POST /v1/heartbeat` (potpisan zahtev)

- Telo tačno `{ "version": "<verzija hotel-api>" }` (Admin Panel odbija druga polja; najviše 64 znaka).
- Odgovor 200: `{ serverTime, latestRevision }`. Kad je `latestRevision` veća od držane, hotel odmah zove
  `GET /v1/license`.
- Interval: 5 min (`HEARTBEAT_INTERVAL_MS`), prvi odmah pri pokretanju.
- Napomena: `apps/hotel-api/package.json` je još `0.0.0`, pa heartbeat šalje tu verziju (odloženo; ugovor o
  ciljnoj verziji traži pravu verziju).

### `GET /v1/keys` i `GET /v1/keys?since=<issued_at>` (javna)

- Bez `since`: trenutni potpisan key set (to je izvor za `HOTEL_ROOT_KEYSET` pri instalaciji).
- Sa `since`: `{ keySets: [...] }`, svi key set-ovi objavljeni posle tog trenutka, od najstarijeg.
  Hotel ih prihvata jedan po jedan (svaki potpisan prethodnim) pri aktivaciji, pri pokretanju, svaka 24 h i
  kad licenca nosi nepoznat ključ. `Cache-Control: public, max-age=300`.

### `POST /v1/products/hotel/manifests` (servisni token)

- `Authorization: Bearer <product_publisher token>`; telo je `product/manifest.json`.
- 2xx objavljeno; `409 manifest_version_exists` znači da je ta verzija već objavljena (nije greška za
  skriptu); ostala odbijanja nose listu problema, skripta ih ispisuje i izlazi sa 1.
- Svaka izmena manifesta traži veću `version`.

## Potpisani zahtevi (kako je implementirano)

`signRequest` iz `@platform/licensing` (Platform Kit `packages/licensing/SPEC.md`, „Potpisani zahtevi"):

| Zaglavlje | Vrednost |
|---|---|
| `X-Installation-Id` | UUID instalacije iz aktivacije |
| `X-Timestamp` | ISO 8601 UTC sa `Z` |
| `X-Nonce` | `[A-Za-z0-9_-]{16,64}`, nikad ponovljen |
| `X-Signature` | base64url bez dopune, Ed25519 potpis (64 bajta) |

Potpisuje se pet redova spojenih sa `\n`: metoda (velika slova), cilj zahteva tačno kako je poslat (putanja +
query, uključujući prefiks iz `CENTRAL_ADMIN_URL`), `X-Timestamp`, `X-Nonce`, SHA-256 sirovog tela (hex). Admin
Panel odbija vreme van ±5 min i ponovljen nonce.

## Podešavanje vlasnika u Admin Panel UI (korak 4 plana)

Radi vlasnik u `http://192.168.1.199:3100`; Admin Panel kod se ne menja.

1. Proizvod `hotel`, podrazumevani režim isteka **`safe_mode`**.
2. Servisni token tipa **`product_publisher`** za proizvod `hotel` (prikazuje se jednom; čuva ga vlasnik).
3. Objava manifesta sa računara (koren repoa):
   `CENTRAL_ADMIN_URL=http://192.168.1.199:4100 HOTEL_PUBLISHER_TOKEN=<token> node scripts/publish-manifest.mjs`.
   Pre toga vlasnik potvrđuje `remote_toggle` vrednosti modula u `product/manifest.json`.
4. Plan sa modulom **`hotel.core`** i limitima **`rooms`** (npr. 20) **i `users`** (npr. 10). Limit koji licenca
   ne nosi hotel tumači kao zabranu (`assertLimit`), pa bez `users` svako `POST /users` (i dodavanje osoblja)
   dobija `403 limit_exceeded`.
5. Pretplata na taj plan, instalacija u pretplati i aktivacioni kod za tu instalaciju (jednokratan).

Zatim korak 5 (`scripts/smoke-1a.mjs`, nastavljiv) i korak 6 (ručna provera) iz CLAUDE.md.

## Zahtevi prema Admin Panelu (otvoreno)

Trenutno nema otvorenih zahteva: proizvod `hotel`, moduli `hotel.*`, planovi, limiti i aktivacioni kodovi rade
kroz postojeći UI i manifest.

Faza 1b ne traži ništa od Admin Panela. Nove akcije (gosti, prijava i odjava, folio, poslovni dan, pravni
profil, poruke) stoje na modulima `hotel.core` i `hotel.folio`, koji su oba već u manifestu kao core moduli
(`product/manifest.json` ostaje `0.1.0`, nova verzija se ne objavljuje). Spec 4.1 vodi `hotel.folio` kao jezgro,
pa plan iz koraka 4 ostaje kakav jeste. Da licenca staging instalacije zaista nosi `hotel.folio` vidi se na
`GET /licence` (to proverava korak 3 skripte `smoke-1b`); ako ga ne nosi, to je zahtev za Admin Panel i upisuje
se ovde. Test `manifest.spec.ts` drži da nova akcija ne može da završi na modulu van `hotel.core` i `hotel.folio`.
