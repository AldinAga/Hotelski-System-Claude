# Hotelski sistem

Spec: `docs/specs/2026-10-10-hotel-system-design.md`.

## Okruženje

Hotelski sistem, Ugostiteljski POS i Centralni Admin Panel dele isti računar i isti NAS:

- **Računar (Windows)** ima izvorni kod, ali nema Docker. Na njemu se ne pokreću baze, testovi ni builds.
- **NAS `192.168.1.199`** (Synology) pokreće sve: Docker, testove, staging, Verdaccio registar.
  Pristup: `ssh -i ~/.ssh/synology_claude_ci claude-ci@192.168.1.199`; Docker je
  `/usr/local/bin/docker`. Obrazac za slanje koda i testiranje je `D:\Claude\Admin Panel\infra\staging\deploy.sh`
  (`git archive` na NAS, build i testovi kroz `docker exec` u dugotrajnom kontejneru).

## Centralni Admin Panel (zajednički za hotel i POS)

Admin Panel (`D:\Claude\Admin Panel`, staging `http://192.168.1.199:3100`, API `:4100`) upravlja
licencama i za POS i za hotel. Kvar u njemu pogađa oba proizvoda, zato:

1. **Admin Panel repo je samo za čitanje** iz hotelskih sesija, isto kao POS repo. Isto važi za
   `D:\Claude\Admin Panel-liquid-glass`.
2. Hotel koristi Admin Panel samo preko javnog ugovora: `@platform/licensing` i `/v1/licenses/check`,
   aktivacija kodom, heartbeat, ciljna verzija za ažuriranje. Hotel nikad ne čita bazu Admin Panela.
3. Sve što hotel traži od Admin Panela (proizvod `hotel`, moduli `hotel.*`, paketi, aktivacioni kodovi)
   je **zaseban zadatak u Admin Panel repou**, unazad kompatibilan za POS, samo uz odobrenje korisnika.
   Hotelska sesija takve potrebe zapisuje u `docs/contracts/admin-panel.md` i ne implementira ih.
4. Na NAS-u se ne diraju `admin-api-claude`, `admin-web-claude`, `admin-worker-claude`, projekti
   `claude-staging` i `claude-ci`, ni njihove baze (`postgres-claude`, `postgres-test-claude`).

## Granice prema Ugostiteljskom POS-u

1. **POS repo je samo za čitanje.** Nikad ne piši, ne commituj, ne menjaj granu i ne pravi ni ne briši
   worktree u `D:\Claude\Ugostiteljski POS` (ni u `repo\.claude\worktrees\*`). Čitanje radi
   razumevanja ugovora je dozvoljeno.
2. **Zasebna baza.** Hotel nikad ne čita ni ne piše u POS bazu. Veza sa POS-om ide samo preko ugovora
   `hotel.pos_link` (lokalni API), nikad preko baze.
3. **Ugovor POS ↔ hotel** (endpointi, format, ključ idempotentnosti = ID POS računa) piše se u ovom
   repou pod `docs/contracts/`. Strana POS-a je poseban zadatak u POS repou.

## Docker na NAS-u

1. **Samo hotelski projekti.** Hotel radi isključivo u Docker projektima `claude-hotel`
   (`docker compose -f infrastructure/docker/docker-compose.yml`, ime je u fajlu) i `claude-hotel-ci`
   (`infrastructure/nas/ci-compose.yml`: runner i test baza). Kontejneri, volume-i i mreže su `hotel-*-claude`.
2. **Tuđe se ne dira.** Nikad `stop`, `restart`, `rm`, `down`, `docker volume rm`, `docker network rm`
   ni `docker system/volume/image prune` nad bilo čim što nije `hotel-*-claude` / `claude-hotel` / `claude-hotel-ci`.
   Na NAS-u rade i: `claude-pos`, `claude-pos-ci`, `pos-nas-dev`, `claude-staging`, `claude-ci`,
   `claude-gh-runner`, `rustdesk-server`, `isponsorblocktv`, `portainer`.
3. **Zamka: projekat `hotelski_system` NIJE hotel.** To je zajednički Verdaccio registar
   (`platform-verdaccio`, `:4873`) od kog zavise svi projekti. Nikad ne koristi to ime projekta.
4. **Nijedan kontejner ne sme sam da se ugasi.** Synology Container Manager šalje mejl za svaki stop,
   i sa `--rm`. Jednokratni poslovi (testovi, migracije, build) idu kroz `docker exec` u dugotrajnom
   hotelskom kontejneru, nikad kroz `docker run`.
5. **Testovi** koriste posebnu test bazu hotela (tmpfs), nikad razvojnu ni bazu drugog projekta.

### Testovi

**GitHub Actions** (`.github/workflows/ci.yml`) je glavni CI: na push (`master`, `phase-**`), PR ka `master` i ručno
radi na NAS runneru (`github-runner-claude`, labele `self-hosted, nas`) install, build, proveru migracija, `pnpm test`
i `pnpm typecheck`. Test baza je `hotel-postgres-test-claude` (priključena i na mrežu `claude-gh-runner_default`
u `ci-compose.yml`); svaki run dobija svoje baze preko `HOTEL_TEST_DB_PREFIX=gh<run_id>_<attempt>_` i na kraju ih briše.
Prvi korak failuje za nekoliko sekundi ako runner ne vidi bazu. Repo je javan: ne koristiti `pull_request_target`,
a odobravanje PR-ova sa forkova ostaje uključeno.

`infrastructure/nas/ci.sh` (stari put) šalje radno stablo na NAS (`ci.sh <ref>` šalje `git archive <ref>`), pa tamo radi
isto kroz `docker exec` u `hotel-ci-runner-claude` (bez prefiksa, baze `hotel_test_N`). `ci.sh --lock` ponovo pravi
`pnpm-lock.yaml` na NAS-u i vraća ga na računar. Na računaru se ne pokreće `pnpm install`.
`ci.sh` sa grane čiji `ci-compose.yml` nema mrežu `gh-runner` odvaja runner od test baze (GitHub run tada pada u prvom koraku).

**Šta se sme obrisati i kada.** Odmah ništa. Posle merge-a ove grane u sve aktivne grane i kad niko više ne koristi `ci.sh`:
(1) `infrastructure/nas/ci.sh`, (2) servis `hotel-ci-runner-claude` iz `ci-compose.yml`, pa
`docker rm -f hotel-ci-runner-claude` (samo to ime), (3) `/volume1/ci/hotel/src` i `/volume1/ci/hotel/pnpm-store`.
`ci.sh --lock` tada treba zameniti (lockfile se pravi ručno uz odobrenje). Ostaje:
`hotel-postgres-test-claude` (koristi ga GitHub CI), `/volume1/ci/hotel/hotel.env`, `/volume1/ci/hotel/deploy`.

### Pokretanje i ažuriranje `claude-hotel`

- **Deploy (staging faze 1a):** `bash infrastructure/nas/deploy.sh [ref]` (podrazumevano `HEAD`).
  `ref` se jednom razrešava u pun SHA. Prvo `gh run list --commit <sha>`: GitHub run "CI" za taj tačan SHA mora imati
  zaključak `success` (bez njega deploy staje s porukom; commit mora biti pushovan na `master` ili `phase-**`).
  Zatim `git archive <sha>` u `/volume1/ci/hotel/deploy` (nikad radno stablo, nikad `src`), dopuna `hotel.env`
  (`hotel-env.sh` iz tog ref-a, samo dodaje), pa `docker buildx build --secret id=npmrc,src=/volume1/ci/.npmrc`
  u `hotel-claude:<sha>`. Install i build rade u build stage-u `infrastructure/docker/Dockerfile` (BuildKit, bez
  kontejnera, pa bez Synology mejlova); registry token je samo secret mount, nikad sloj, ARG, ENV ni log; web se gradi
  sa `HOTEL_API_URL=http://hotel-api-claude:4200`. Na NAS-u je `docker buildx` v0.14.1 (plugin korisnika `claude-ci`
  u `~/.docker/cli-plugins`); klasični `docker build` ne zna secrete. Zatim provera da se baze i Redis ne bi ponovo
  napravili, pa tek onda oznaka `hotel-claude:staging`. `deploy.sh --dry-run [ref]` samo proverava GitHub run
  (NAS se ne dira); `deploy.sh --build-check [ref]` posle te provere gradi `hotel-claude:buildx-check` iz
  `/volume1/ci/hotel/buildx-check` i staje (bez `hotel.env`, `:staging` i kontejnera); posle toga ručno
  `docker rmi hotel-claude:buildx-check` i `rm -rf /volume1/ci/hotel/buildx-check`. Baze i Redis se samo pokreću ako nedostaju
  (`up -d --no-recreate --wait postgres hub-postgres redis`, nikad se ne prave ponovo), a `api` i
  `web` idu sa `up -d --no-deps --remove-orphans --wait api web`. Čišćenje: ostaju 3 najnovije
  `hotel-claude:<sha>` oznake. Ne dira ništa van `claude-hotel`, `hotel-claude` i `/volume1/ci/hotel/deploy`.
- **Neuspelo pokretanje API-ja:** `hotel-api-claude` se ne gasi (nema crash-loop-a ni mejlova). Greška
  (bez tajni) je u `docker logs hotel-api-claude`, a do popravke i restarta kontejner je `Up (unhealthy)`
  i `/health` vraća 503.
- **Staging adrese:** API `http://192.168.1.199:4200` (`/health`), recepcija `http://192.168.1.199:4201`.
  Kod za prvo podešavanje: `docker logs hotel-api-claude 2>&1 | grep "Kod za prvo podešavanje"`.
  Smoke (koraci 4–6 plana, sa vlasnikom): `HOTEL_SMOKE_PASSWORD=… node scripts/smoke-1a.mjs --api http://192.168.1.199:4200
  --email <pravi email vlasnika> --property-name "<pravo ime objekta>" --setup-token … --code … --totp-out ~/owner-totp.txt`.
  Nastavljiv je: čita `/setup/status` i preskače urađeno (aktivacija je jednokratna, baze se ne prave ponovo);
  posle završenog podešavanja prijavljuje vlasnika sa `--totp <kod>` ili `--totp-file owner-totp.txt` umesto da ga pravi.
  Ostavlja prave podatke: ime objekta i vlasnika (nema podrazumevanih), tip i cenovnik `SMOKE` (jedinice S-1, S-2) i
  otkazane rezervacije. TOTP URI nikad ne ispisuje. Plan u Admin Panelu (korak 4) mora imati limite `rooms` **i**
  `users` (bez `users` je `POST /users` 403 `limit_exceeded`); ručna provera (korak 6) nema „aktivaciju", jer je
  smoke već aktivirao instalaciju. Ugovor i podešavanje vlasnika: `docs/contracts/admin-panel.md`.
  Smoke se pokreće samo dok je Turnstile isključen (nema `TURNSTILE_*` ključeva u `hotel.env`): ne šalje token,
  pa bi prijava bila 403 `captcha_failed` i sa test ključevima.
- **CSRF:** API prima samo JSON tela (ostalo je 415) i odbija POST/PUT/PATCH/DELETE kad `Origin` (ili, bez njega,
  `Sec-Fetch-Site`) pokazuje tuđu adresu (403 `origin_refused`), jer SameSite ne razlikuje portove na istom hostu
  (Admin Panel, POS, Portainer). Bez `HOTEL_WEB_ORIGIN` dozvoljen je samo `Origin` jednak hostu kome je zahtev
  poslat (kroz Next rewrite to je `X-Forwarded-Host`, tj. adresa recepcije); sa njim samo navedeni origin-i
  (lista sa zarezima). Skripte i klijenti bez `Origin` i `Sec-Fetch-Site` prolaze. Produkcija dobija svoj hostname.
- **Secure kolačić:** API veruje `X-Forwarded-Proto` od proksija sa privatnih adresa (trust proxy), pa je kolačić
  `Secure` kad recepcija radi preko HTTPS-a; HTTP na LAN-u (staging) ostaje kako jeste.
- **Cloudflare Turnstile na prijavi:** isključen dok u `/volume1/ci/hotel/hotel.env` nisu oba ključa,
  `TURNSTILE_SITE_KEY` i `TURNSTILE_SECRET_KEY` (samo jedan: ostaje isključen, a log API-ja imenuje onaj koji
  nedostaje). Uključuje se ručno: oba reda se dopisuju u `hotel.env` (vrednosti se ne ispisuju i ne idu u repo),
  pa `bash infrastructure/nas/deploy.sh` ponovo podiže `api`; web čita site key iz `GET /auth/config` u toku rada,
  bez novog builda. U Cloudflare-u widget mora da ima hostname recepcije (npr. `192.168.1.199` ili produkcijski
  domen), inače se ne prikazuje. Za probu na stagingu Cloudflare-ovi test ključevi koji uvek prolaze: site
  `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`. Opciono `TURNSTILE_HOSTNAMES` (lista sa
  zarezima): token rešen na drugom hostu se odbija (test ključevi vraćaju `example.com`, pa uz njih ostaje prazno).
  Prazan `action` u odgovoru prihvata se samo uz test site key. Smoke radi samo dok je Turnstile isključen (gore).
  Ugovor i odluke: `docs/contracts/turnstile.md`.
- **Manifest proizvoda:** `product/manifest.json`; objava `CENTRAL_ADMIN_URL=http://192.168.1.199:4100
  HOTEL_PUBLISHER_TOKEN=… node scripts/publish-manifest.mjs` (servisni token `product_publisher`,
  samo uz odobrenje korisnika; svaka izmena manifesta traži veću `version`).
- **E-mail (SMTP), faza 1b:** potvrde i otkazi rezervacija idu kroz izlazno sanduče. Vlasnik sam dopisuje
  `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` i `MAIL_FROM` u
  `/volume1/ci/hotel/hotel.env` (imena su u `.env.example`; vrednosti se ne ispisuju i ne idu u repo), pa
  `bash infrastructure/nas/deploy.sh` ponovo podiže `api`. Bez `SMTP_HOST` ili `MAIL_FROM` poruke se čuvaju,
  ali se ne šalju, a ekran rezervacije piše „Nije poslato: SMTP nije podešen." Kad se ključevi dopišu, na
  poruci se koristi „Pošalji ponovo".
- **Pozadinski poslovi:** `hotel-api` sam pokreće dispečer izlaznog sandučeta (`OutboxDispatcher`) i
  automatsko zatvaranje dana (`NightAuditScheduler`), samo iz `main.ts` posle migracija i provere licence.
  Poseban kontejner ili cron ne postoji i ne sme da se dodaje. Zatvaranje se uključuje vremenom
  `auto_close_time` u podešavanjima objekta (prazno: nema automatskog zatvaranja). Licenca koja bi odbila
  ručno zatvaranje isključuje i automatsko.
- **Poslovni dan posle deploy-a 1b:** migracija `0009` otvara poslovni dan na dan migracije (današnji datum objekta). Prvo
  zatvaranje dana (tog dana migracije) prevodi u no-show svaki boravak u statusu `expected` sa dolaskom do tog
  dana uključujući, i to samo kad je njegova rezervacija potvrđena; zato i gost koji je trebalo da stigne baš
  na dan migracije, a nije prijavljen, postaje no-show. Navodi ih u izveštaju i skida ih sa kalendara. Zatvaranje je trajno, pa ga na stagingu (prave podatke Demo Hotela) pokreće samo
  korisnik; sesija implementera ga ne zatvara.
- **`smoke-1b` (stiže sa Taskom 14, još ne postoji):** `HOTEL_SMOKE_PASSWORD=… node scripts/smoke-1b.mjs
  --api http://192.168.1.199:4200 --email <vlasnik> (--totp <6 cifara> | --totp-file ~/owner-totp.txt)
  [--allow-close] [--mail-to <adresa>]`. Radi samo dok je Turnstile isključen. Bez `--allow-close` staje
  kad poslovni dan kasni. Ostavlja prave podatke (gost „Smoke Test 1b", zatvoreni dani, nefiskalni računi
  `N-…`), pa ga pokreće korisnik, ne implementer.
- Kod za ručno pokretanje baza: `git archive HEAD | ssh … "tar -x -C /volume1/ci/hotel/src"` (pre toga `rm -rf` samo
  `/volume1/ci/hotel/src`).
- Lozinke: `/volume1/ci/hotel/hotel.env` (`600`, nasumične, napravljene 2026-10-26). Pravi se samo jednom
  i posle se ne menja, jer baze već imaju podatke sa tim lozinkama. Lozinke se ne ispisuju i ne kopiraju
  u repo. `deploy.sh` mu samo dodaje `HOTEL_SECRET_KEY`, `HOTEL_ROOT_KEYSET` i `DATABASE_URL` kad
  nedostaju; postojeće vrednosti ne menja. Proverava se samo po imenima ključeva (`cut -d= -f1`).
- Ručno pokretanje baza i Redisa (samo ta tri servisa; `api` i `web` podiže isključivo `deploy.sh`):
  `/usr/local/bin/docker compose -f /volume1/ci/hotel/src/infrastructure/docker/docker-compose.yml
  --env-file /volume1/ci/hotel/hotel.env up -d --no-recreate --wait postgres hub-postgres redis`.
- Redis nema lozinku; dostupan je samo na `127.0.0.1` NAS-a i u mreži `hotel-network-claude`.
- Provera lozinke radi se preko Docker mreže (iz drugog kontejnera). Unutar Postgres kontejnera
  `127.0.0.1` prolazi bez lozinke, pa test tu ne dokazuje ništa.

### Oporavak TOTP-a

Vlasnik resetuje TOTP menadžeru ili drugom vlasniku kroz `POST /users/:id/reset-totp`. Ako je poslednji
vlasnik izgubio aplikaciju za autentifikaciju, na NAS-u:
`docker exec hotel-api-claude node dist/auth/reset-totp-cli.js --email <email>`. Komanda ispisuje novi
`otpauth://` URI (QR), gasi sve sesije tog korisnika, a nova tajna postaje aktivna prvom prijavom sa kodom iz nje.
URI je tajna: ne čuva se u logu ni u repou.

## Portovi

Novi servis dobija sledeći slobodan port iz opsega `4200–4299` i upisuje se u tabelu, `.env.example` i
compose. Infrastrukturni portovi su vezani na `127.0.0.1` NAS-a; sa računara se dolazi SSH tunelom.
Staging `hotel-api` (`4200:4200`) i `hotel-web` (`4201:3000` u kontejneru) slušaju na svim adresama NAS-a.

| Servis | Port na NAS-u |
|---|---|
| `hotel-api` | 4200 |
| `hotel-web` (recepcija) | 4201 |
| `hotel-hub` API | 4210 |
| `hotel-hub` web (sajtovi, booking engine, guest portal) | 4211 |
| `hotel-device-agent` | 4220 |
| Adminer (`tools` profil) | 4280 |
| PostgreSQL instalacije (`hotel-postgres-claude`) | 5442 |
| PostgreSQL huba (`hotel-hub-postgres-claude`) | 5443 |
| Redis (`hotel-redis-claude`) | 6390 |

Zauzeto na NAS-u (provereno 2026-10-26), ne koristiti: `3003`, `3100`, `3306`, `4100`, `4873`,
`5000`, `5001`, `5432`, `5433`, `6379`, `8000`, `8417`, `9000`, `13000`, `13001`, `13005`, `13006`,
`13100`, `18081`, `18082`, `21115–21119`. U POS compose fajlu za lokalni razvoj su još `3000–3002`,
`8080–8085`, `9090`, `9093`, `9100`, `9121`, `9187`. Pre dodele novog porta proveri NAS:
`ss -tln` ili `docker ps --format '{{.Ports}}'`.

## Imena

Redis ključevi i BullMQ redovi imaju prefiks `hotel:`.

## `platform-kit`

Hotel koristi objavljene verzije `@platform/*` paketa sa Verdaccia (`http://192.168.1.199:4873`).
Izmena u `D:\Claude\Platform Kit` je zaseban, unazad kompatibilan zadatak sa novom verzijom, samo uz
odobrenje korisnika, jer od istih paketa zavise POS i Admin Panel.
