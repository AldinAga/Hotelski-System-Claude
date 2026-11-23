# Faza 1b (recepcija): završni izveštaj

Datum: 23.11.2026. Grana: `phase-1b-operations`, commit `21c67b5`, poslata na GitHub, CI zelen.
U `master` nije spojeno. Deploy na staging nije rađen.

## Šta je gotovo

Zadaci 1–13 i koraci 1–3 zadatka 14. Obim 1b: gosti, prijava i odjava, folio i plaćanja
(nefiskalni računi i predračuni), poslovni dan i noćni audit, pravni profil objekta,
e-mail potvrde i otkazi, dugme „Back to top“ u unutrašnjoj aplikaciji.
Posle završne recenzije (tri recenzenta po oblastima, bez kritičnih nalaza) urađen je jedan talas ispravki:

- Server (F1–F8): kopija baze pre deploy-a, otisak sadržaja migracija, vremenska ograničenja veze ka bazi i
  provera baze u `/health`, test za pokretanje pozadinskih poslova, strožiji test sigurnog režima,
  zaključavanje po ključu zahteva preko tabela, fiksan tekst kad automatsko zatvaranje padne, dva test vektora (PIB, JMBG).
- Web (W1–W7): ponovno čitanje folija pre naplate, upozorenje kad poslovni dan kasni, ispravan 80 mm format štampe,
  obnova ključeva dokumenata, vremensko ograničenje od 30 s, tekstovi i oznake polja, fokus u prozorima.
- Recenzija ispravki servera našla je jedan važan problem: ponovni deploy istog SHA-a prepisivao je jedinu kopiju
  baze iz vremena pre migracije. Ispravljeno u `6112efd`.

Testovi: server 54 skupa, 720 testova; web i provera tipova zeleni; GitHub CI na `21c67b5` uspešan.

## Provere pre deploy-a na staging (vi, bez koda)

1. `SELECT name FROM schema_migrations WHERE name >= '0008'` mora da vrati prazno (migracija `0011` je menjana posle prve upotrebe).
2. Rezervacije u statusu `expected` sa dolaskom pre danas i odlaskom posle danas: odlučite za svaku. Ne mogu da se prijave,
   a prvo zatvaranje dana ih beleži kao no-show i oslobađa sobu.
3. `GET /licence` mora da sadrži `hotel.folio`.
4. Na ovom računaru `gh auth login` (traži ga `deploy.sh`).
5. Automatsko zatvaranje ostavite praznim ili na rano jutro: vreme se odnosi na sledeći kalendarski dan.
   Stopu PDV-a za smeštaj podesite pre prve knjižene noći.

Koraci 4–7 zadatka 14 (deploy, `smoke-1b` sa `--allow-close`, provera na 375 px i štampe) idu samo uz vas.

## Šta nije proveravano

- `backup-db.sh` nikad nije pokrenut na pravom `hotel-postgres-claude`, ni vraćanje iz kopije.
- Zaključavanje po ključu zahteva (F6): rad bez zastoja je obrazložen čitanjem, nije probano pod opterećenjem.
- Vremensko ograničenje upita od 60 s je procenjeno, nije mereno (zatvaranje dana je niz malih upita).
- 80 mm štampa: pravu potvrdu daje samo stvarni pregled štampe.
- GitHub runner slika mora imati `bash` (NAS runner ga ima).

## Namerno ostavljeno za kasnije

- Zaključavanje prijave po e-mailu (dug iz 1a, pre produkcije).
- Token za registar na stalnom CI runneru: može li da objavljuje na Verdaccio? (pitanje za vas)
- Rani odlazak briše redove `stay_night`, a audit čuva samo datume (pre spajanja u `master`).
- Folio otkazanih i no-show boravaka se nikad ne zatvara (1c).
- `book` ne uzima zaključavanje dana (vaša odluka, pravilo redosleda zaključavanja).
- Veličina serije izlaznog sandučeta, token za preuzimanje reda, `stop_grace_period`.
- E-mailovi sačuvani dok SMTP nije podešen traže ručno „Pošalji ponovo“.
- Ključ idempotentnosti pri dodavanju gosta.
- Web ne prikazuje tekst greške automatskog zatvaranja (`details.message` uz `close_failed`).
- Filter grešaka više ne proverava `res.headersSent`; kopija baze ne obuhvata bazu huba.
- Sitnice weba: prozor za zatvaranje dana ima svoju kopiju zamke za Tab; zakasneli dan se čita jednom pri otvaranju stranice;
  ključevi dokumenata se ne obnavljaju posle izgubljenog plaćanja i „Odustani“; poruka „Server nije dostupan“ pri isteku 30 s.
- Uklanjanje `ci.sh` i NAS runnera tek kad se grana spoji svuda i niko ih više ne koristi.

## Odluke koje sam doneo (Rulings) i cena ako su pogrešne

| # | Odluka | Cena ako je pogrešno |
|---|---|---|
| 1 | `phase-1b-operations` je nastala od `portal-liquid-glass`; 1a i portal nisu u `master` | preraspoređivanje grana |
| 2 | Obim 1b je interni domen; e-Turista i fiskalizacija idu u 1c | preraspoređivanje zadataka |
| 3 | Staging ima prave podatke; migracije 1b moraju da prođu na postojećoj bazi; `smoke-1b` je nastavljiv | — |
| 4 | Plaćanja bez fiskalnog dokumenta uz natpis „Ovo nije fiskalni račun.“; tvrda blokada stiže u 1c | dodatna blokada u 1c |
| 5 | Zatvaranje dana je dozvoljeno u sigurnom režimu; MB se proverava samo po formatu | jeftina izmena |
| 6 | `fiscal-rs` ne postoji na Verdaccio (404): fiskalizacija traži zaseban zadatak u Platform Kitu uz vaše odobrenje | — |
| 7 | Prihvaćeni preflight nalazi 1–39, uključujući odstupanja od specifikacije (status `no_show`, pozadinski poslovi u `hotel-api`, `source_id` može biti null u `0010`) | ispravke u recenzijama |
| 27, 27a, 28 | Testovi trke drže sve transakcije na barijeri, imaju odbijajući timeout, N ispod veličine pool-a, a držana transakcija se oslobađa u `finally` | nema |
| 29 | Prihvaćena odstupanja zadatka 3 (test manifesta, test licence samo sa `hotel.core`, `null` na ne-nullable podešavanjima je 422) | male izmene testova |
| 30 | Stavke folija u jednoj transakciji sortiraju se po noći | mala izmena upita |
| 31 | `postNight` traži da folio pripada boravku i da je otvoren | jedan uslov |
| 32 | Paralelan rad lakših modela pod Fable koordinatorom (na vaš zahtev 12.11.) | — |
| 33 | Prihvaćeno: raspoređivač poštuje licencu; no-show prve noći se broji | jedan uslov |
| 34 | Ispravke zadatka 6 radi novi sonnet u zasebnom worktree-u | još jedan krug sa originalnim implementerom |
| 35 | GitHub CI radi na NAS runneru (GitHub serveri ne vide Verdaccio); test baza je priključena na mrežu runnera preko `ci-compose.yml` | — |
| 36 | Ispravke zadatka 7 u zasebnom worktree-u dok zadatak 8 teče | sukobi u `messages.ts` |
| 37 | Pravni profil: PUT sme da ponovi `kind`, ne da ga promeni (422) | jedna grana provere |
| 38 | „kasni 1 dan“ umesto „1 dana“ | jedan tekst |
| 39 | Za krugove ispravki kad je kontekst implementera ogroman, novi sonnet | — |
| 40 | Otkaz zatvara neposlate potvrde kao `skipped`; ponovno slanje takve je 409 | jedan dodatni status |
| 41 | Dispečer preskače potvrde otkazanih rezervacija; slanje u toku se ne može zaustaviti | jedan join |
| 42 | Završna recenzija kao tri paralelna recenzenta po oblastima | — |
| 43 | Web upozorava i traži drugu potvrdu pri odjavi dok je dan nezatvoren (ne blokira); pri prijavi prikazuje razlog | recepcioner svesno potvrđuje nenaplaćenu noć |
| 44 | Završni talas ispravki u dva dela (server i infrastruktura, web), bez zajedničkih fajlova | dva konteksta umesto jednog |
| 45 | Ispravka kopije baze (ostaje postojeća kopija za isti SHA) radi novi sonnet | — |

## Sledeći koraci

1. Vaše provere gore, pa deploy i smoke zajedno.
2. Spajanje u `master` redom: `phase-1a-foundation`, `portal-liquid-glass`, `phase-1b-operations` (samo uz vaše odobrenje).
3. Posle toga: brisanje završenih worktree-ova i grane `phase-1b-ci-verify` na GitHub-u, pa uklanjanje `ci.sh` i NAS runnera.
