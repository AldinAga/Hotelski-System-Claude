# Ugovor: Cloudflare Turnstile na prijavi recepcije

Zaštita `POST /auth/login` od automatizovanih pokušaja. Hotel koristi Cloudflare samo kao spoljni servis za
proveru tokena; Admin Panel i POS se ne menjaju. Strana API-ja: `apps/hotel-api/src/auth/turnstile.ts`,
strana weba: `apps/hotel-web/src/lib/turnstile.ts` i `src/app/prijava/page.tsx`.

## Podešavanje

| Promenljiva | Značenje |
|---|---|
| `TURNSTILE_SITE_KEY` | Javni ključ widgeta. Web ga dobija iz `GET /auth/config` u toku rada (bez novog builda). |
| `TURNSTILE_SECRET_KEY` | Tajni ključ za siteverify. Nikad u logu, u odgovoru ni u repou. |
| `TURNSTILE_HOSTNAMES` | Opciono, lista sa zarezima. Kad je postavljena, token rešen na drugom hostu je 403. |

Uključeno je samo kad su postavljena oba ključa. Bez ijednog: isključeno, prijava radi kao ranije. Samo jedan:
isključeno, a API pri pokretanju upiše jedan red sa imenom ključa koji nedostaje (bez vrednosti). Adresa
siteverify (`https://challenges.cloudflare.com/turnstile/v0/siteverify`) namerno nema promenljivu okruženja;
testovi je menjaju samo kroz Nest provider (`test/fake-turnstile.ts`).

U Cloudflare-u widget mora da ima hostname recepcije, inače se ne prikazuje. Test ključevi (uvek prolaze):
site `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`. Odgovor siteverify za njih ima
prazan `action` i hostname `example.com`, pa se uz njih `TURNSTILE_HOSTNAMES` ostavlja prazan. Prazan `action`
se prihvata samo kad je site key Cloudflare-ov test ključ (`/^[123]x0{20}AA$/`); sa pravim ključem mora biti
`login`.

## Rute hotela

### `GET /auth/config` (javna, bez sesije, `@Unlicensed`)

Odgovor 200: `{ "turnstileSiteKey": "<site key>" | null }`. Ništa drugo; tajni ključ se nikad ne vraća.

### `POST /auth/login`

Telo kao do sada (`email`, `password`, `totp`), a kad je Turnstile uključen i `turnstileToken` (string do 2048
znakova, iz widgeta sa `action: "login"`). Redosled na serveru:

1. Provera tokena, pre svega ostalog. Neuspela provera se **ne broji** kao pokušaj prijave za tu e-adresu i ne
   dolazi do lozinke. Zato neuspeli captcha ne može da zaključa tuđi nalog (limit od 5 pokušaja za 15 minuta
   ostaje vezan za stvarne pokušaje lozinkom), a odgovor je isti za postojeću i nepostojeću adresu.
   **Odluka (zapisana):** za neuspele captcha pokušaje zasad nema posebnog ograničenja brzine; svaki košta jedan
   poziv prema Cloudflare-u. Ograničenje po adresi klijenta na putu captcha-e je naknadni zadatak (traži
   pouzdanu adresu klijenta, vidi ispod).
2. Tek posle toga brojanje pokušaja, lozinka i TOTP, kao ranije.

Greške Turnstile-a:

| Status | `code` | Kada |
|---|---|---|
| 403 | `captcha_failed` | Nema tokena ili nije string; prazan ili duži od 2048; siteverify `success: false`; `action` nije `login` (prazan samo uz Cloudflare-ov test site key); hostname nije na listi `TURNSTILE_HOSTNAMES`. |
| 503 | `captcha_unavailable` | Siteverify nedostupan, bez odgovora za 5 s, status različit od 200 ili odgovor nije JSON. Fail closed: prijava se odbija. |

## Poziv prema Cloudflare-u

`POST https://challenges.cloudflare.com/turnstile/v0/siteverify`, telo `application/json`:
`{ secret, response: <token>, idempotency_key: <novi UUID> }`, `redirect: 'error'`, vremensko ograničenje 5 s.
Ponovnog pokušaja nema; ključ idempotentnosti samo označava ovaj jedan poziv.

`remoteip` se **ne šalje** (Cloudflare ga ne traži). Express veruje `X-Forwarded-For` od svih privatnih adresa
(`TRUSTED_PROXIES`, `src/http.ts`), a to je i svaki klijent na LAN-u, dok `:4200` sluša na svim adresama NAS-a.
`req.ip` bi zato bio ono što klijent tvrdi. Test `a forged X-Forwarded-For never reaches siteverify` to drži.

## Web

`/prijava` pita `GET /auth/config`. Bez site key-a (ili kad poziv ne uspe) ne učitava se nikakva skripta i telo
prijave nema token. Sa site key-om se jednom učitava
`https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`, widget se crta u staklenoj kartici
(`theme: auto` prati svetlu ili tamnu temu, `size: flexible`, a `compact` kad je ekran uži od 365 px),
token ide uz prijavu, a posle svake neuspele
prijave widget se resetuje (token je jednokratan). Dok provera nije gotova, forma traži da se sačeka i ne šalje
ništa. Ako prijava vrati `captcha_failed`, a stranica nema widget (poziv `/auth/config` nije uspeo), stranica
ponovo pita API i prikaže widget; ako ključa i dalje nema, poruka kaže da se stranica osveži. CSP za `/prijava` dozvoljava `https://challenges.cloudflare.com` u `script-src` i `frame-src`; ostale
stranice zadržavaju strožu politiku (`apps/hotel-web/next.config.ts`).
