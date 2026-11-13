// The legal profile form: what it holds, what it refuses before sending, and
// the body it sends. The checks mirror hotel-api legal-profile.service.ts
// (same texts); the API decides, this only spares the round trip.

import type { AccommodationCategory, FiscalComplianceMode, LegalKind, LegalProfile } from './business';
import { JMBG_MASK_CHAR, isValidJmbg, isValidMb, isValidPib, jmbgFault } from './legal-ids';

export interface LegalForm {
  /** Chosen on the first save only; afterwards the profile's kind is shown and cannot change. */
  kind: LegalKind | '';
  legalName: string;
  taxId: string;
  registryId: string;
  vatPayer: boolean;
  address: string;
  postalCode: string;
  city: string;
  activityCode: string;
  bankAccount: string;
  email: string;
  phone: string;
  accommodationCategory: AccommodationCategory | '';
  categorizationNumber: string;
  /** Empty: not chosen yet, the API picks the default for the kind. */
  fiscalComplianceMode: FiscalComplianceMode | '';
}

export type LegalFormField = keyof LegalForm;
export type LegalFormErrors = Partial<Record<LegalFormField, string>>;

/** Top to bottom as the form shows them: the first with an error gets the focus. */
export const FORM_ORDER: LegalFormField[] = [
  'kind',
  'legalName',
  'taxId',
  'registryId',
  'vatPayer',
  'address',
  'postalCode',
  'city',
  'activityCode',
  'bankAccount',
  'email',
  'phone',
  'accommodationCategory',
  'categorizationNumber',
  'fiscalComplianceMode',
];

export function formOf(p: LegalProfile): LegalForm {
  return {
    kind: p.kind ?? '',
    legalName: p.legalName ?? '',
    taxId: p.taxId ?? '',
    registryId: p.registryId ?? '',
    vatPayer: p.vatPayer,
    address: p.address ?? '',
    postalCode: p.postalCode ?? '',
    city: p.city ?? '',
    activityCode: p.activityCode ?? '',
    bankAccount: p.bankAccount ?? '',
    email: p.email ?? '',
    phone: p.phone ?? '',
    accommodationCategory: p.accommodationCategory ?? '',
    categorizationNumber: p.categorizationNumber ?? '',
    fiscalComplianceMode: p.fiscalComplianceMode ?? '',
  };
}

/** True while the registry id field still holds the masked JMBG the API showed. */
export function isShownMask(form: LegalForm, profile: LegalProfile): boolean {
  return profile.kind === 'natural_person' && profile.registryId !== null && form.registryId === profile.registryId;
}

function pibError(v: string): string | null {
  if (!/^\d{9}$/.test(v)) return 'PIB nije ispravan: mora imati tačno 9 cifara.';
  return isValidPib(v) ? null : 'PIB nije ispravan: kontrolna cifra se ne slaže.';
}

function jmbgError(v: string): string | null {
  if (v.startsWith(JMBG_MASK_CHAR)) return 'Upišite ceo JMBG (13 cifara) ili ostavite polje kako je.';
  if (!/^\d{13}$/.test(v)) return 'JMBG nije ispravan: mora imati tačno 13 cifara.';
  if (isValidJmbg(v)) return null;
  return `JMBG nije ispravan: ${jmbgFault(v) === 'date' ? 'datum rođenja ne postoji.' : 'kontrolna cifra se ne slaže.'}`;
}

/**
 * What the form refuses before sending. PIB and the registry id are required
 * of a legal entity and an entrepreneur (the API refuses a profile without
 * them, and refuses a change of the fiscal mode alone on a row where they are
 * empty); a natural person's JMBG is optional.
 */
export function validate(form: LegalForm, profile: LegalProfile): LegalFormErrors {
  const errors: LegalFormErrors = {};
  const kind = profile.kind ?? (form.kind || null);
  if (kind === null) {
    errors.kind = 'Izaberite vrstu lica.';
    return errors;
  }

  const taxId = form.taxId.trim();
  if (taxId !== '') {
    const e = pibError(taxId);
    if (e) errors.taxId = e;
  } else if (kind !== 'natural_person') {
    errors.taxId = 'PIB je obavezan.';
  }

  const registryId = form.registryId.trim();
  if (kind === 'natural_person') {
    if (registryId !== '' && !isShownMask(form, profile)) {
      const e = jmbgError(registryId);
      if (e) errors.registryId = e;
    }
  } else if (registryId === '') {
    errors.registryId = 'Matični broj je obavezan.';
  } else if (!isValidMb(registryId)) {
    errors.registryId = 'Matični broj nije ispravan: mora imati tačno 8 cifara.';
  }
  return errors;
}

const orNull = (v: string): string | null => (v.trim() === '' ? null : v.trim());

/**
 * The whole form as the PUT body. kind goes only with the first save. The
 * masked JMBG is left out while it is unchanged, so the stored one stays; the
 * fiscal mode is left out until one is chosen (the API takes no null there).
 */
export function bodyOf(form: LegalForm, profile: LegalProfile): Record<string, unknown> {
  const body: Record<string, unknown> = {
    legalName: orNull(form.legalName),
    taxId: orNull(form.taxId),
    vatPayer: form.vatPayer,
    address: orNull(form.address),
    postalCode: orNull(form.postalCode),
    city: orNull(form.city),
    activityCode: orNull(form.activityCode),
    bankAccount: orNull(form.bankAccount),
    email: orNull(form.email),
    phone: orNull(form.phone),
    accommodationCategory: form.accommodationCategory === '' ? null : form.accommodationCategory,
    categorizationNumber: orNull(form.categorizationNumber),
  };
  if (profile.kind === null) body.kind = form.kind;
  if (!isShownMask(form, profile)) body.registryId = orNull(form.registryId);
  if (form.fiscalComplianceMode !== '') body.fiscalComplianceMode = form.fiscalComplianceMode;
  return body;
}
