import { ApiError } from './api';
import { formatDate } from './format';

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
  unit_has_stays: 'Jedinici je dodeljen boravak koji još traje. Prvo ga premestite na drugu jedinicu, pa ponovo pokušajte.',
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

  // reservations (front desk, used from the next screens on)
  no_availability: 'Nema slobodnih jedinica za {day}.',
  price_missing: 'Za {day} nije uneta cena.',
  closed: 'Dan {day} je zatvoren za prodaju.',
  bad_date: 'Neispravan datum.',
  departure_not_after_arrival: 'Datum odlaska mora biti posle datuma dolaska.',
  arrival_in_past: 'Datum dolaska ne može biti u prošlosti.',
  too_long: 'Boravak može trajati najviše 365 noći.',
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
};

function fill(template: string, details: Record<string, unknown> | null): string | null {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = details?.[key];
    if (v === undefined || v === null) {
      missing = true;
      return '';
    }
    if (key === 'field') return FIELD_LABELS[String(v)] ?? String(v);
    if (key === 'day' && typeof v === 'string') return formatDate(v);
    return String(v);
  });
  return missing ? null : out;
}

/** The text to show for any error a screen caught. */
export function messageFor(err: unknown): string {
  if (!(err instanceof ApiError)) return MESSAGES.unknown;
  const template = MESSAGES[err.code];
  if (template) {
    const text = fill(template, err.details);
    if (text !== null) return text;
  }
  return err.message || MESSAGES.unknown;
}
