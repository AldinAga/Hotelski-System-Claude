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

1. **Samo hotelski projekat.** Hotel radi isključivo u Docker projektu `claude-hotel`
   (`docker compose -f infrastructure/docker/docker-compose.yml`, ime je u fajlu). Kontejneri, volume-i
   i mreže su `hotel-*-claude`.
2. **Tuđe se ne dira.** Nikad `stop`, `restart`, `rm`, `down`, `docker volume rm`, `docker network rm`
   ni `docker system/volume/image prune` nad bilo čim što nije `hotel-*-claude` / `claude-hotel`.
   Na NAS-u rade i: `claude-pos`, `claude-pos-ci`, `pos-nas-dev`, `claude-staging`, `claude-ci`,
   `claude-gh-runner`, `rustdesk-server`, `isponsorblocktv`, `portainer`.
3. **Zamka: projekat `hotelski_system` NIJE hotel.** To je zajednički Verdaccio registar
   (`platform-verdaccio`, `:4873`) od kog zavise svi projekti. Nikad ne koristi to ime projekta.
4. **Nijedan kontejner ne sme sam da se ugasi.** Synology Container Manager šalje mejl za svaki stop,
   i sa `--rm`. Jednokratni poslovi (testovi, migracije, build) idu kroz `docker exec` u dugotrajnom
   hotelskom kontejneru, nikad kroz `docker run`.
5. **Testovi** koriste posebnu test bazu hotela (tmpfs), nikad razvojnu ni bazu drugog projekta.

## Portovi

Novi servis dobija sledeći slobodan port iz opsega `4200–4299` i upisuje se u tabelu, `.env.example` i
compose. Infrastrukturni portovi su vezani na `127.0.0.1` NAS-a; sa računara se dolazi SSH tunelom.

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
