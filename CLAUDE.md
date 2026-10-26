# Hotelski sistem

Spec: `docs/specs/2026-10-10-hotel-system-design.md`.

## Granice prema Ugostiteljskom POS-u

Hotelski sistem i Ugostiteljski POS razvijaju se paralelno, često u isto vreme na istoj mašini.
Ova pravila sprečavaju da rad na hotelu pokvari POS.

1. **POS repo je samo za čitanje.** Nikad ne piši, ne commituj, ne menjaj granu i ne pravi ni ne briši
   worktree u `D:\Claude\Ugostiteljski POS` (ni u `repo\.claude\worktrees\*`). Čitanje radi
   razumevanja ugovora je dozvoljeno.
2. **Ne diraj POS-ove kontejnere.** Nikad ne pokreći `docker compose down`, `stop`, `rm`,
   `docker volume rm` ni `docker system prune` nad bilo čim što počinje sa `ugpos-`, niti `docker` komande
   bez `-p hotel` / `--project-name hotel`. Za hotel uvek koristi
   `docker compose -f infrastructure/docker/docker-compose.yml` (projekt `hotel` je u fajlu).
3. **Samo hotelski portovi.** Hotel koristi isključivo portove iz tabele ispod. Novi servis dobija
   sledeći slobodan port iz opsega `4200–4299` i upisuje se u tabelu, `.env.example` i compose.
4. **Zasebna baza.** Hotel nikad ne čita ni ne piše u POS bazu (`ugpos-postgres`, port 5432).
   Veza sa POS-om ide samo preko ugovora `hotel.pos_link` (lokalni API), nikad preko baze.
5. **Imena.** Docker projekt `hotel`; kontejneri, volume-i i mreže imaju prefiks `hotel-`.
   Redis ključevi i BullMQ redovi imaju prefiks `hotel:`.
6. **`platform-kit` se ne menja usput.** Hotel koristi objavljene verzije `@platform/*` paketa
   (Verdaccio). Izmena u `D:\Claude\Platform Kit` je zaseban, unazad kompatibilan zadatak sa novom
   verzijom, samo uz odobrenje korisnika; POS je preuzima kada korisnik odluči.
7. **Ugovor POS ↔ hotel** (endpointi, format, ključ idempotentnosti = ID POS računa) piše se u ovom
   repou pod `docs/contracts/`. Strana POS-a je poseban zadatak u POS repou.

## Portovi

| Servis | Port na hostu |
|---|---|
| `hotel-api` | 4200 |
| `hotel-web` (recepcija) | 4201 |
| `hotel-hub` API | 4210 |
| `hotel-hub` web (sajtovi, booking engine, guest portal) | 4211 |
| `hotel-device-agent` | 4220 |
| Adminer (`tools` profil) | 4280 |
| PostgreSQL instalacije (`hotel-postgres`) | 5442 |
| PostgreSQL huba (`hotel-hub-postgres`) | 5443 |
| Redis (`hotel-redis`) | 6390 |

Zauzeto drugim projektima, ne koristiti: POS `3000–3002`, `3100`, `5432`, `5540`, `6379`, `8080–8085`,
`9090`, `9093`, `9100`, `9121`, `9187`, `13006`; Admin Panel staging `3100`, `4100`; Verdaccio `4873`.
