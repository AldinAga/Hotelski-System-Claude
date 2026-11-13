import { ApiError } from './api';
import { formatDate, formatRsd } from './format';

/**
 * What the person at the desk reads for every error code the screens can
 * receive from hotel-api. {name} is filled from the error's details; a day is
 * shown as D.M.YYYY. A code missing here falls back to the API's own message.
 */
export const MESSAGES: Record<string, string> = {
  // connection
  network_error: 'Server nije dostupan. Proverite vezu i pokušajte ponovo.',
  unknown: 'Došlo je do greške. Pokušajte ponovo.',

  // first-run setup and activation
  setup_done: 'Prvo podešavanje je već završeno.',
  setup_token_invalid: 'Kod za prvo podešavanje nije ispravan. Prepišite ga iz loga servera (hotel-api).',
  not_activated: 'Instalacija još nije aktivirana. Prvo unesite aktivacioni kod iz Centralnog admina.',
  already_activated: 'Instalacija je već aktivirana.',
  owner_missing: 'Prvo unesite podatke vlasnika.',
  totp_invalid: 'Kod iz aplikacije za autentifikaciju nije ispravan. Unesite trenutni šestocifreni kod.',
  activation_refused: 'Centralni admin je odbio aktivacioni kod ({parentCode}). Proverite kod ili se obratite podršci.',
  activation_rejected: 'Licenca dobijena pri aktivaciji nije prošla proveru, pa instalacija nije aktivirana. Obratite se podršci.',
  licensing_not_configured: 'Licenciranje na serveru nije podešeno. Obratite se podršci.',
  central_admin_unavailable: 'Centralni admin trenutno nije dostupan. Aktivacioni kod je verovatno još važeći; pokušajte ponovo.',
  property_missing: 'Objekat još nije podešen. Završite prvo podešavanje.',

  // sign-in and roles
  invalid_credentials: 'Neispravna e-adresa ili lozinka.',
  totp_required: 'Unesite šestocifreni kod iz aplikacije za autentifikaciju.',
  totp_not_enrolled: 'Aplikacija za autentifikaciju još nije potvrđena za ovaj nalog. Obratite se vlasniku.',
  too_many_attempts: 'Previše neuspešnih pokušaja prijave. Pokušajte ponovo za 15 minuta.',
  session_required: 'Prijavite se da biste nastavili.',
  forbidden_role: 'Vaša uloga nema pravo na ovu radnju.',
  origin_refused: 'Zahtev je poslat sa druge adrese i odbijen je. Otvorite recepciju direktno i pokušajte ponovo.',
  unsupported_media_type: 'Zahtev mora biti poslat kao JSON.',
  // Cloudflare Turnstile on sign-in (the last two are the page's own, not the API's)
  captcha_failed: 'Provera da niste robot nije prošla. Pokušajte ponovo.',
  captcha_unavailable: 'Provera da niste robot trenutno nije dostupna. Pokušajte ponovo za minut.',
  captcha_pending: 'Sačekajte da se završi provera da niste robot, pa pokušajte ponovo.',
  captcha_load_failed: 'Provera da niste robot nije mogla da se učita. Proverite vezu i osvežite stranicu.',
  captcha_reload: 'Prijava traži proveru da niste robot, a ona se nije učitala. Osvežite stranicu.',
  actor_changed: 'Vaš nalog je u međuvremenu izmenjen. Prijavite se ponovo.',
  password_too_short: 'Lozinka mora imati najmanje {min} znakova.',
  password_too_long: 'Lozinka može imati najviše {max} znakova.',

  // licence
  safe_mode_blocked: 'Licenca je istekla. Sistem radi u sigurnom režimu: pregled je dozvoljen, izmene nisu.',
  expired_hard_lock: 'Licenca je istekla. Obratite se podršci.',
  invalid_license: 'Licenca nije ispravna. Obratite se podršci.',
  module_not_licensed: 'Ovaj modul nije uključen u licencu.',
  route_not_classified: 'Ova radnja nije razvrstana za licencu. Obratite se podršci.',
  limit_exceeded: 'Licenca dozvoljava najviše {limit} (traženo {wanted}). Za više se obratite podršci.',

  // input
  validation_failed: 'Proverite polje „{field}“.',

  // unit types and units
  unit_type_not_found: 'Tip jedinice ne postoji. Osvežite stranicu.',
  unit_type_code_taken: 'Tip jedinice sa ovom oznakom već postoji.',
  unit_type_in_use: 'Tip ima aktivne jedinice. Prvo ih premestite na drugi tip ili isključite.',
  unit_type_inactive: 'Tip jedinice je isključen. Izaberite aktivan tip.',
  unit_not_found: 'Jedinica ne postoji. Osvežite stranicu.',
  unit_name_taken: 'Jedinica sa ovim nazivom već postoji.',
  unit_inactive: 'Jedinica je isključena.',
  unit_has_blocks: 'Jedinica ima blokadu koja još traje. Prvo uklonite blokadu, pa ponovo pokušajte.',
  unit_has_stays:
    'Jedinici je dodeljen boravak koji još traje. Boravak rezervisan po tipu premestite na drugu jedinicu na stranici rezervacije; boravak na jedinici bez tipa ne može da se premesti, pa ga otkažite ili sačekajte da se završi.',
  inventory_conflict: 'Za {day} je već prodato ili blokirano više jedinica nego što bi ostalo posle ove izmene.',
  scope_not_found: 'Tip ili jedinica ne postoji. Osvežite stranicu.',

  // blocks
  unit_occupied: 'Jedinica je u tom periodu zauzeta boravkom.',
  block_overlap: 'Jedinica je u tom periodu već blokirana.',
  block_ended: 'Blokada je završena i ne može se ukloniti.',
  block_not_found: 'Blokada ne postoji. Osvežite stranicu.',

  // rates
  rate_plan_not_found: 'Cenovnik ne postoji. Osvežite stranicu.',
  rate_plan_code_taken: 'Cenovnik sa ovom oznakom već postoji.',
  rate_plan_inactive: 'Cenovnik nije aktivan.',
  range_too_long: 'Opseg može imati najviše {max} dana.',
  scope_not_priced: 'Jedinica ima tip; cene se unose za tip jedinice.',

  // reservations (front desk: calendar, new reservation, reservation page)
  no_availability: 'Nema slobodnih jedinica za {day}.',
  price_missing: 'Za {day} nije uneta cena.',
  closed: 'Dan {day} je zatvoren za prodaju.',
  bad_date: 'Neispravan datum.',
  departure_not_after_arrival: 'Datum odlaska mora biti posle datuma dolaska.',
  arrival_in_past: 'Datum dolaska ne može biti u prošlosti.',
  arrival_before_business_date: 'Datum dolaska je pre otvorenog poslovnog dana. Izaberite dolazak od poslovnog dana nadalje.',
  too_long: 'Boravak može trajati najviše 365 noći.',
  unit_taken: 'Jedinica je već zauzeta u tom periodu.',
  unit_blocked: 'Jedinica je blokirana u tom periodu.',
  unit_type_mismatch: 'Jedinica nije rezervisanog tipa.',
  reservation_not_found: 'Rezervacija ne postoji. Osvežite stranicu.',
  reservation_not_cancellable: 'Rezervacija se ne može otkazati u ovom stanju.',
  stay_not_found: 'Boravak ne postoji. Osvežite stranicu.',
  stay_not_assignable: 'Boravku se ne može dodeliti jedinica u ovom stanju.',
  version_conflict: 'Rezervaciju je u međuvremenu neko izmenio. Osvežite prikaz i pokušajte ponovo.',

  // business day and night audit
  business_day_mismatch: 'Otvoren je drugi poslovni dan ({open}). Osvežite prikaz.',
  business_day_in_future: 'Poslovni dan {day} još nije počeo (danas je {today}) i ne može da se zatvori.',
  close_blocked: 'Gosti koji odlaze još nisu odjavljeni. Odjavite ih, pa zatvorite dan.',
  close_failed: 'Noćenje nije moglo da se proknjiži, pa je dan ostao otvoren. Obratite se podršci.',
  business_day_not_found: 'Poslovni dan nije zatvoren ili ne postoji.',

  // folio documents (non-fiscal receipt, pro forma)
  document_empty: 'Folio nema nijednu stavku ni plaćanje, pa dokument ne može da se izda.',
  document_not_found: 'Dokument ne postoji. Osvežite stranicu.',

  // folio: charges, payments, refunds, corrections
  line_not_found: 'Stavka folija ne postoji. Osvežite stranicu.',
  payment_not_found: 'Plaćanje ne postoji. Osvežite stranicu.',
  folio_closed: 'Folio je zatvoren i ne prima nove stavke ni plaćanja.',
  idempotency_key_reused:
    'Ovaj zahtev je već zabeležen, ali sa drugačijim podacima. Zatvorite prozor i proverite folio pre nego što pokušate ponovo.',
  stay_not_chargeable: 'Na boravak u ovom stanju ne mogu se dodavati zaduženja.',
  cannot_reverse_correction: 'Storno stavka se ne može stornirati.',
  line_already_reversed: 'Stavka je već stornirana.',
  refund_exceeds_credit: 'Povraćaj ne može biti veći od preplate na foliju ({creditMinor}).',
  cannot_void_reversal: 'Storno plaćanja se ne može stornirati.',
  payment_already_voided: 'Plaćanje je već stornirano.',

  // check-in and check-out
  check_in_wrong_day: 'Dolazak je {arrival}, a poslovni dan je {businessDate}. Zatvorite poslovni dan pre prijave gosta.',
  // The same code when the arrival is already behind the business day (see messageFor).
  check_in_wrong_day_past: 'Dolazak je bio {arrival}, a poslovni dan je {businessDate}. Prijava na dan dolaska više nije moguća.',
  unit_required: 'Prvo dodelite jedinicu boravku.',
  reservation_not_confirmed: 'Rezervacija nije potvrđena, pa se gost ne može prijaviti.',
  stay_not_expected: 'Prijaviti se može samo gost čiji se dolazak očekuje. Osvežite prikaz.',
  stay_not_in_house: 'Odjaviti se može samo gost koji je prijavljen. Osvežite prikaz.',
  folio_balance_open: 'Saldo folija nije nula ({balanceMinor}). Naplatite ili vratite razliku pre odjave.',

  // guests of a stay
  guest_not_found: 'Gost ne postoji. Osvežite stranicu.',
  guest_not_on_stay: 'Gost nije na ovom boravku. Osvežite stranicu.',
  guest_already_on_stay: 'Gost je već na ovom boravku.',
  too_many_guests: 'Na boravku može biti najviše {limit} gostiju (odrasli i deca zajedno).',
  primary_guest_required: 'Nosilac boravka se ne može ukloniti. Prvo postavite drugog nosioca.',
  stay_not_editable: 'Gosti se ne mogu menjati na boravku u ovom stanju.',

  // reservation e-mails
  message_not_found: 'Poruka ne postoji. Osvežite stranicu.',
  message_already_sent: 'Poruka je već poslata.',
  message_has_no_recipient: 'Gost nema e-adresu, pa poruka ne može da se pošalje.',
};

/** Field names in validation_failed details, as the forms label them. */
const FIELD_LABELS: Record<string, string> = {
  code: 'Oznaka',
  name: 'Naziv',
  capacity: 'Kapacitet',
  beds: 'Ležajevi',
  unitTypeId: 'Tip',
  from: 'Od',
  to: 'Do',
  reason: 'Razlog',
  note: 'Napomena',
  priceMinor: 'Cena',
  closed: 'Zatvoreno',
  scope: 'Za koga važi cena',
  board: 'Usluga',
  discount7Pct: 'Popust 7+ noći',
  discount30Pct: 'Popust 30+ noći',
  email: 'E-adresa',
  password: 'Lozinka',
  propertyName: 'Naziv objekta',
  legalKind: 'Pravni oblik',
  setupToken: 'Kod za prvo podešavanje',
  legalName: 'Pun naziv',
  taxId: 'PIB',
  registryId: 'Matični broj / JMBG',
  vatPayer: 'Obveznik PDV-a',
  address: 'Adresa',
  postalCode: 'Poštanski broj',
  city: 'Mesto',
  activityCode: 'Šifra delatnosti',
  bankAccount: 'Broj računa',
  phone: 'Telefon',
  accommodationCategory: 'Vrsta smeštaja',
  categorizationNumber: 'Broj rešenja o kategorizaciji',
  kind: 'Pravni oblik',
  fiscalComplianceMode: 'Fiskalizacija',
  source: 'Izvor',
  channel: 'Kanal',
  'holder.firstName': 'Ime',
  'holder.lastName': 'Prezime',
  'holder.email': 'E-adresa',
  'holder.phone': 'Telefon',
  'holder.language': 'Jezik',
  stays: 'Boravci',
  arrival: 'Dolazak',
  departure: 'Odlazak',
  adults: 'Odrasli',
  children: 'Deca',
  ratePlanId: 'Cenovnik',
  unitId: 'Jedinica',
  version: 'Verzija',
  q: 'Pretraga',
  guestId: 'Gost',
  firstName: 'Ime',
  lastName: 'Prezime',
  // folio: charges, payments, refunds and corrections
  kind: 'Vrsta',
  description: 'Opis',
  amountMinor: 'Iznos',
  vatRateBp: 'PDV stopa',
  method: 'Način plaćanja',
  reference: 'Referenca',
  key: 'Ključ zahteva',
  'guest.firstName': 'Ime',
  'guest.lastName': 'Prezime',
  'guest.email': 'E-adresa',
  'guest.phone': 'Telefon',
};

/** "stays[0].adults" → "adults": the forms show one stay at a time. */
function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? FIELD_LABELS[field.replace(/^stays\[\d+\]\./, '')] ?? field;
}

function fill(template: string, details: Record<string, unknown> | null): string | null {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = details?.[key];
    if (v === undefined || v === null) {
      missing = true;
      return '';
    }
    if (key === 'field') return fieldLabel(String(v));
    if ((key === 'day' || key === 'arrival' || key === 'businessDate') && typeof v === 'string') return formatDate(v);
    if ((key === 'balanceMinor' || key === 'creditMinor') && typeof v === 'number') return formatRsd(v);
    return String(v);
  });
  return missing ? null : out;
}

/**
 * check_in_wrong_day means two things: the open business day is still behind
 * the arrival (close it first), or it is already past it (nothing to close).
 */
function codeFor(err: ApiError): string {
  if (err.code !== 'check_in_wrong_day') return err.code;
  const { arrival, businessDate } = err.details ?? {};
  return typeof arrival === 'string' && typeof businessDate === 'string' && arrival < businessDate
    ? 'check_in_wrong_day_past'
    : err.code;
}

/** The text to show for any error a screen caught. */
export function messageFor(err: unknown): string {
  if (!(err instanceof ApiError)) return MESSAGES.unknown;
  const template = MESSAGES[codeFor(err)];
  if (template) {
    const text = fill(template, err.details);
    if (text !== null) return text;
  }
  return err.message || MESSAGES.unknown;
}
