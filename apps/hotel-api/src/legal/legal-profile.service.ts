import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../common/audit.service';
import { CLOCK, type Clock } from '../common/clock';
import { asBody, optionalText, requireOneOf, validationFailed, EMAIL_MAX, type Body } from '../common/input';
import { PropertyContext } from '../common/property-context';
import { DB, type Db, type Tx } from '../db/tokens';
import type { Actor } from '../reservations/reservations.service';
import { isValidBankAccount, isValidJmbg, isValidMb, isValidPib, jmbgFault, JMBG_MASK_CHAR, maskJmbg } from './legal-ids';

// The property's legal profile: who issues the documents. Reading never
// writes (the row is made by setup). The JMBG of a natural person is personal
// data: it is stored in full, but every answer and every audit row carries it
// masked, and a PUT that sends the mask back keeps the stored value.

export const LEGAL_KINDS = ['legal_entity', 'entrepreneur', 'natural_person'] as const;
export type LegalKind = (typeof LEGAL_KINDS)[number];
export const ACCOMMODATION_CATEGORIES = [
  'hotel',
  'motel',
  'hostel',
  'guest_house',
  'apartment',
  'room',
  'house',
  'rural_household',
  'other',
] as const;
export type AccommodationCategory = (typeof ACCOMMODATION_CATEGORIES)[number];
export const FISCAL_COMPLIANCE_MODES = ['required', 'invoice_only', 'disabled'] as const;
export type FiscalComplianceMode = (typeof FISCAL_COMPLIANCE_MODES)[number];

export interface LegalProfileView {
  /** Null while the profile has not been saved (F30). */
  kind: LegalKind | null;
  legalName: string | null;
  taxId: string | null;
  /** MB; for a natural person the JMBG, masked. */
  registryId: string | null;
  vatPayer: boolean;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  activityCode: string | null;
  bankAccount: string | null;
  email: string | null;
  phone: string | null;
  accommodationCategory: AccommodationCategory | null;
  categorizationNumber: string | null;
  fiscalComplianceMode: FiscalComplianceMode | null;
  /** Shown while fiscalisation is required but not switched on (Ruling 4). */
  fiscalNotice: 'not_available_yet' | null;
  /** True when nothing needed for an invoice is missing. */
  complete: boolean;
  /** View field names still empty that an invoice needs. */
  missing: string[];
}

/** The stored profile, registryId unmasked. Never leaves this file. */
interface Stored {
  kind: LegalKind;
  legalName: string | null;
  taxId: string | null;
  registryId: string | null;
  vatPayer: boolean;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  activityCode: string | null;
  bankAccount: string | null;
  email: string | null;
  phone: string | null;
  accommodationCategory: AccommodationCategory | null;
  categorizationNumber: string | null;
  fiscalComplianceMode: FiscalComplianceMode;
}

type Row = {
  kind: LegalKind;
  legal_name: string | null;
  tax_id: string | null;
  registry_id: string | null;
  vat_payer: boolean;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  activity_code: string | null;
  bank_account: string | null;
  email: string | null;
  phone: string | null;
  accommodation_category: AccommodationCategory | null;
  categorization_number: string | null;
  fiscal_compliance_mode: FiscalComplianceMode;
};

const COLUMNS = sql`kind, legal_name, tax_id, registry_id, vat_payer, address, postal_code, city, activity_code,
  bank_account, email, phone, accommodation_category, categorization_number, fiscal_compliance_mode`;

function storedOf(r: Row): Stored {
  return {
    kind: r.kind,
    legalName: r.legal_name,
    taxId: r.tax_id,
    registryId: r.registry_id,
    vatPayer: r.vat_payer,
    address: r.address,
    postalCode: r.postal_code,
    city: r.city,
    activityCode: r.activity_code,
    bankAccount: r.bank_account,
    email: r.email,
    phone: r.phone,
    accommodationCategory: r.accommodation_category,
    categorizationNumber: r.categorization_number,
    fiscalComplianceMode: r.fiscal_compliance_mode,
  };
}

/** The registry id as shown: a natural person's JMBG masked, an MB as it is. */
function shownRegistryId(s: Stored): string | null {
  return s.kind === 'natural_person' && s.registryId !== null ? maskJmbg(s.registryId) : s.registryId;
}

/** What an invoice needs and the profile still lacks. */
function missingOf(s: Stored): string[] {
  const missing: string[] = [];
  if (!s.legalName) missing.push('legalName');
  if (!s.address) missing.push('address');
  if (!s.city) missing.push('city');
  if (s.kind !== 'natural_person') {
    if (!s.taxId) missing.push('taxId');
    if (!s.registryId) missing.push('registryId');
  }
  return missing;
}

/** Fiscalisation is required of companies and entrepreneurs, not of a natural person (same rule as the 0011 backfill). */
export function defaultFiscalComplianceMode(kind: LegalKind): FiscalComplianceMode {
  return kind === 'natural_person' ? 'disabled' : 'required';
}

/** What GET answers before the profile exists (F30). A fresh object each time: callers may not share it. */
function emptyView(): LegalProfileView {
  return {
    kind: null,
    legalName: null,
    taxId: null,
    registryId: null,
    vatPayer: false,
    address: null,
    postalCode: null,
    city: null,
    activityCode: null,
    bankAccount: null,
    email: null,
    phone: null,
    accommodationCategory: null,
    categorizationNumber: null,
    fiscalComplianceMode: null,
    fiscalNotice: null,
    complete: false,
    missing: ['legalName', 'address', 'city', 'taxId', 'registryId'],
  };
}

function viewOf(s: Stored): LegalProfileView {
  const missing = missingOf(s);
  return {
    ...s,
    registryId: shownRegistryId(s),
    fiscalNotice: s.fiscalComplianceMode === 'required' ? 'not_available_yet' : null,
    complete: missing.length === 0,
    missing,
  };
}

/** The audit snapshot: the profile as the screen sees it, without the derived fields. */
function auditOf(s: Stored): Record<string, unknown> {
  return { ...s, registryId: shownRegistryId(s) };
}

const TEXT_FIELDS = [
  ['legalName', 200],
  ['address', 200],
  ['postalCode', 20],
  ['city', 100],
  ['activityCode', 10],
  ['categorizationNumber', 50],
  ['phone', 50],
] as const;

const refuse = (field: string, message: string) => validationFailed(field, message);

/** PIB, trimmed: nine digits and a matching check digit, with the reason in the message. */
function checkPib(v: string): void {
  if (!/^\d{9}$/.test(v)) throw refuse('taxId', 'PIB nije ispravan: mora imati tačno 9 cifara.');
  if (!isValidPib(v)) throw refuse('taxId', 'PIB nije ispravan: kontrolna cifra se ne slaže.');
}

function checkMb(v: string): void {
  if (!isValidMb(v)) throw refuse('registryId', 'Matični broj nije ispravan: mora imati tačno 8 cifara.');
}

function checkJmbg(v: string): void {
  if (!/^\d{13}$/.test(v)) throw refuse('registryId', 'JMBG nije ispravan: mora imati tačno 13 cifara.');
  if (!isValidJmbg(v)) {
    const why = jmbgFault(v) === 'date' ? 'datum rođenja ne postoji.' : 'kontrolna cifra se ne slaže.';
    throw refuse('registryId', `JMBG nije ispravan: ${why}`);
  }
}

/**
 * The fields present in a PUT body, checked field by field. Absent fields are
 * left out (the stored value stays), null or blank clears an optional field.
 * Whether taxId and registryId may be empty depends on the stored kind and is
 * decided in update(). A registryId that starts with the mask character is
 * dropped for a natural person: the screen sent back what it was shown.
 */
export function parseLegalProfileInput(raw: unknown, kind: LegalKind): Partial<Omit<Stored, 'kind'>> {
  const b: Body = asBody(raw);
  const out: Partial<Omit<Stored, 'kind'>> = {};

  for (const [field, max] of TEXT_FIELDS) {
    const v = optionalText(b, field, max);
    if (v !== undefined) out[field] = v;
  }

  const taxId = optionalText(b, 'taxId', 20);
  if (taxId !== undefined) {
    if (taxId !== null) checkPib(taxId);
    out.taxId = taxId;
  }

  const registryId = optionalText(b, 'registryId', 20);
  if (registryId !== undefined) {
    const kept = kind === 'natural_person' && registryId !== null && registryId.startsWith(JMBG_MASK_CHAR);
    if (!kept) {
      if (registryId !== null) (kind === 'natural_person' ? checkJmbg : checkMb)(registryId);
      out.registryId = registryId;
    }
  }

  const bank = optionalText(b, 'bankAccount', 30);
  if (bank !== undefined) {
    if (bank !== null && !isValidBankAccount(bank)) {
      throw refuse('bankAccount', 'Broj računa nije ispravan: očekuje se oblik 160-0000000123456-78.');
    }
    out.bankAccount = bank;
  }

  const email = optionalText(b, 'email', EMAIL_MAX);
  if (email !== undefined) {
    if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw validationFailed('email');
    out.email = email;
  }

  if (b.vatPayer !== undefined) {
    if (typeof b.vatPayer !== 'boolean') throw validationFailed('vatPayer');
    out.vatPayer = b.vatPayer;
  }

  if (b.accommodationCategory !== undefined) {
    const v = b.accommodationCategory;
    if (v !== null && (typeof v !== 'string' || !(ACCOMMODATION_CATEGORIES as readonly string[]).includes(v))) {
      throw validationFailed('accommodationCategory');
    }
    out.accommodationCategory = v as AccommodationCategory | null;
  }

  if (b.fiscalComplianceMode !== undefined) {
    const v = b.fiscalComplianceMode;
    if (typeof v !== 'string' || !(FISCAL_COMPLIANCE_MODES as readonly string[]).includes(v)) throw validationFailed('fiscalComplianceMode');
    out.fiscalComplianceMode = v as FiscalComplianceMode;
  }
  return out;
}

@Injectable()
export class LegalProfileService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly property: PropertyContext,
  ) {}

  /** Without a row: kind and every field null, complete false. Writes nothing and never throws for it (F30). */
  async get(): Promise<LegalProfileView> {
    const propertyId = await this.property.id();
    const stored = await this.read(this.db, propertyId, false);
    return stored ? viewOf(stored) : emptyView();
  }

  /**
   * The same read on the caller's transaction connection, for code that already
   * holds one: `get()` would ask the pool for a second connection, and enough
   * concurrent callers would each wait for a connection none of them can get.
   * Takes the property id the caller already has (PropertyContext may hit the
   * pool). Writes nothing and takes no row lock.
   */
  async getIn(tx: Tx, propertyId: string): Promise<LegalProfileView> {
    const stored = await this.read(tx, propertyId, false);
    return stored ? viewOf(stored) : emptyView();
  }

  /**
   * Upsert. Without a row, kind is required in the body and decides the
   * default fiscal compliance mode. With a row, kind may be repeated but not
   * changed (422 field kind): it decides what registryId means.
   */
  async update(raw: unknown, actor: Actor): Promise<LegalProfileView> {
    const propertyId = await this.property.id();
    const body = asBody(raw);
    return this.db.transaction(async (tx) => {
      const existing = await this.read(tx, propertyId, false);
      if (!existing) {
        const kind = requireOneOf(body, 'kind', LEGAL_KINDS);
        // Two first PUTs at once: the loser finds the row the winner made and updates it.
        await tx.execute(sql`
          INSERT INTO legal_profile (property_id, kind, fiscal_compliance_mode, updated_at)
          VALUES (${propertyId}, ${kind}, ${defaultFiscalComplianceMode(kind)},
                  ${this.clock().toISOString()}::timestamptz)
          ON CONFLICT (property_id) DO NOTHING`);
      }
      const before = (await this.read(tx, propertyId, true))!;
      if (body.kind !== undefined && requireOneOf(body, 'kind', LEGAL_KINDS) !== before.kind) {
        throw refuse('kind', 'Pravni oblik se ne menja na ovom ekranu.');
      }
      const patch = parseLegalProfileInput(body, before.kind);
      const after: Stored = { ...before, ...patch };
      if (after.kind !== 'natural_person') {
        if (!after.taxId) throw refuse('taxId', 'PIB je obavezan.');
        if (!after.registryId) throw refuse('registryId', 'Matični broj je obavezan.');
      }
      await tx.execute(sql`
        UPDATE legal_profile
           SET legal_name = ${after.legalName}, tax_id = ${after.taxId}, registry_id = ${after.registryId},
               vat_payer = ${after.vatPayer}, address = ${after.address}, postal_code = ${after.postalCode},
               city = ${after.city}, activity_code = ${after.activityCode}, bank_account = ${after.bankAccount},
               email = ${after.email}, phone = ${after.phone},
               accommodation_category = ${after.accommodationCategory},
               categorization_number = ${after.categorizationNumber}, fiscal_compliance_mode = ${after.fiscalComplianceMode},
               updated_at = ${this.clock().toISOString()}::timestamptz
         WHERE property_id = ${propertyId}`);
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'legal_profile.update',
        entity: 'legal_profile',
        entityId: propertyId,
        before: existing ? auditOf(before) : null,
        after: auditOf(after),
      });
      return viewOf(after);
    });
  }

  private async read(q: Db | Tx, propertyId: string, lock: boolean): Promise<Stored | null> {
    const { rows } = await q.execute<Row>(
      lock
        ? sql`SELECT ${COLUMNS} FROM legal_profile WHERE property_id = ${propertyId} FOR UPDATE`
        : sql`SELECT ${COLUMNS} FROM legal_profile WHERE property_id = ${propertyId}`,
    );
    return rows[0] ? storedOf(rows[0]) : null;
  }
}
