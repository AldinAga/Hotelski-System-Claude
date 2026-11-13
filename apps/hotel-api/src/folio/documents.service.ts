import { Inject, Injectable } from '@nestjs/common';
import { add, divide, fromMinor, multiply, subtract, zero, type Money } from '@platform/money';
import { sql } from 'drizzle-orm';
import { BusinessDayService } from '../business-day/business-day.service';
import { SettingsService } from '../business-day/settings.service';
import { AuditService } from '../common/audit.service';
import { CLOCK, type Clock } from '../common/clock';
import { DomainError } from '../common/domain-error';
import { findKey, parseKey, requestHash } from '../common/idempotency';
import { asBody, isUniqueViolation, isUuid, requireOneOf } from '../common/input';
import { PropertyContext } from '../common/property-context';
import { DB, type Db, type Tx } from '../db/tokens';
import { LegalProfileService } from '../legal/legal-profile.service';
import type { Actor } from '../reservations/reservations.service';
import {
  CHARGEABLE,
  constraintOf,
  FolioService,
  keyReused,
  nightDescription,
  type Written,
} from './folio.service';

// Non-fiscal receipts and pro-forma invoices of a folio (Task 8). A document
// is a snapshot: its content is computed once, when it is issued, stored as
// it is and never recomputed (folio_document is append-only, trigger in 0012).
//
// Numbers: N-{year}-{000001} for a receipt, P-... for a pro forma, per kind and
// year of the business date, without gaps. The counter row is updated in the
// issuing transaction, so a failed issue rolls its number back too.
//
// Lock order (constraints): the open business_day FOR SHARE (point 0, which
// also gives the business date), then the counter row (point 5), then the
// folio (point 6). The counter row is locked without being raised first, and
// raised only after the request key was looked up and the content is known
// (preflight F5): a replayed key or a refused issue never takes a number.

export type DocumentKind = 'receipt' | 'proforma';
const KINDS = ['receipt', 'proforma'] as const;
const PREFIX: Record<DocumentKind, string> = { receipt: 'N', proforma: 'P' };
export const NOT_FISCAL = 'Ovo nije fiskalni račun.' as const;
const CURRENCY = 'RSD';

export interface DocumentLine {
  description: string;
  night: string | null;
  amountMinor: number;
  vatRateBp: number | null;
  /** A night the pro forma expects but that is not posted yet. */
  expected: boolean;
}

export interface DocumentContent {
  kind: DocumentKind;
  number: string;
  issuedAt: string;
  businessDate: string;
  notice: typeof NOT_FISCAL;
  seller: {
    legalName: string | null;
    taxId: string | null;
    /** A natural person's JMBG, masked. */
    registryId: string | null;
    address: string | null;
    postalCode: string | null;
    city: string | null;
    bankAccount: string | null;
    vatPayer: boolean;
  };
  guest: { name: string; email: string | null };
  reservation: { number: string; arrival: string; departure: string; unit: string | null };
  lines: DocumentLine[];
  payments: Array<{ method: string; amountMinor: number; businessDate: string }>;
  totalMinor: number;
  paidMinor: number;
  dueMinor: number;
  /** VAT included in the prices, per rate; only when the seller is a VAT payer and every line has a rate. */
  vat: Array<{ rateBp: number; baseMinor: number; vatMinor: number }> | null;
}

export interface DocumentView {
  id: string;
  kind: DocumentKind;
  number: string;
  issuedAt: string;
  content: DocumentContent;
}

export interface DocumentListItem {
  id: string;
  kind: DocumentKind;
  number: string;
  issuedAt: string;
}

const stayNotFound = () => new DomainError('stay_not_found', 'Boravak ne postoji.', 404);
const documentNotFound = () => new DomainError('document_not_found', 'Dokument ne postoji.', 404);

const sum = (amounts: number[]): Money => amounts.reduce((acc, a) => add(acc, fromMinor(a, CURRENCY)), zero(CURRENCY));

/**
 * The VAT contained in the prices, per rate in ascending order: the lines of
 * a rate are summed, then vat = round(sum × rate / (10000 + rate)) once, half-up
 * (an integer product divided once, preflight F32), base = sum − vat. null when
 * the seller is not a VAT payer or any line has no rate.
 */
export function vatOf(lines: Array<{ amountMinor: number; vatRateBp: number | null }>, vatPayer: boolean): DocumentContent['vat'] {
  if (!vatPayer || lines.some((l) => l.vatRateBp === null)) return null;
  const byRate = new Map<number, number[]>();
  for (const l of lines) byRate.set(l.vatRateBp as number, [...(byRate.get(l.vatRateBp as number) ?? []), l.amountMinor]);
  return [...byRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rateBp, amounts]) => {
      const gross = sum(amounts);
      const vat = divide(multiply(gross, rateBp), 10_000 + rateBp);
      return { rateBp, baseMinor: subtract(gross, vat).amount_minor, vatMinor: vat.amount_minor };
    });
}

type DocumentRow = { id: string; kind: DocumentKind; number: string; issued_at: string | Date; content: DocumentContent };

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly property: PropertyContext,
    private readonly days: BusinessDayService,
    private readonly settings: SettingsService,
    private readonly folio: FolioService,
    private readonly legal: LegalProfileService,
  ) {}

  /** Issues a receipt or a pro forma for a stay's folio (created when missing). */
  async issue(stayId: string, raw: unknown, actor: Actor): Promise<Written<DocumentView>> {
    const b = asBody(raw);
    const kind = requireOneOf(b, 'kind', KINDS);
    const key = parseKey(b);
    if (!isUuid(stayId)) throw stayNotFound();
    const propertyId = await this.property.id();
    const hash = requestHash('folio.document', stayId, { kind });

    try {
      return await this.db.transaction(async (tx) => {
        const businessDate = await this.days.lockOpen(tx, propertyId, 'share');
        // An unknown stay is 404 from ensureFolio below; the counter row it may have made rolls back.
        const year = Number(businessDate.slice(0, 4));
        // Lock order point 5, before the folio (6): the counter row, locked but not raised yet.
        await tx.execute(sql`
          INSERT INTO document_counter (property_id, kind, year, last) VALUES (${propertyId}, ${kind}, ${year}, 0)
          ON CONFLICT (property_id, kind, year) DO NOTHING`);
        await tx.execute(sql`
          SELECT last FROM document_counter WHERE property_id = ${propertyId} AND kind = ${kind} AND year = ${year} FOR UPDATE`);
        const folio = await this.folio.ensureFolio(tx, propertyId, stayId);

        const found = await findKey(tx, propertyId, key);
        if (found) {
          if (found.source !== 'folio_document' || found.request_hash !== hash) throw keyReused();
          return { created: false, view: await this.byId(tx, propertyId, found.id) };
        }

        const issuedAt = this.clock().toISOString();
        const body = await this.contentOf(tx, propertyId, stayId, folio.id, kind);
        if (body.lines.length === 0 && body.payments.length === 0) {
          throw new DomainError('document_empty', 'Folio nema nijednu stavku ni plaćanje, pa dokument ne može da se izda.', 409);
        }

        const { rows: counted } = await tx.execute<{ last: number }>(sql`
          UPDATE document_counter SET last = last + 1
           WHERE property_id = ${propertyId} AND kind = ${kind} AND year = ${year}
          RETURNING last`);
        const number = `${PREFIX[kind]}-${year}-${String(counted[0].last).padStart(6, '0')}`;
        const content: DocumentContent = { kind, number, issuedAt, businessDate, notice: NOT_FISCAL, ...body };

        const { rows } = await tx.execute<{ id: string }>(sql`
          INSERT INTO folio_document (property_id, folio_id, kind, number, business_date, content, idempotency_key,
                                      request_hash, issued_by, issued_at)
          VALUES (${propertyId}, ${folio.id}, ${kind}, ${number}, ${businessDate}::date, ${JSON.stringify(content)}::jsonb,
                  ${key}, ${hash}, ${actor.id}, ${issuedAt}::timestamptz)
          RETURNING id`);
        const id = rows[0].id;
        await this.audit.record(tx, {
          propertyId,
          actorUserId: actor.id,
          action: 'folio.document',
          entity: 'folio_document',
          entityId: id,
          after: { folioId: folio.id, stayId, kind, number, businessDate, totalMinor: content.totalMinor, dueMinor: content.dueMinor },
        });
        return { created: true, view: { id, kind, number, issuedAt, content } };
      });
    } catch (err) {
      // The same key at once on two folios: the unique index decides (FolioService.write does the same).
      if (isUniqueViolation(err) && constraintOf(err) === 'folio_document_key') throw keyReused();
      throw err;
    }
  }

  /** The documents of a stay, oldest first; an unknown stay is 404. Writes nothing. */
  async list(stayId: string): Promise<DocumentListItem[]> {
    if (!isUuid(stayId)) throw stayNotFound();
    const propertyId = await this.property.id();
    return this.db.transaction(
      async (tx) => {
        await this.stay(tx, propertyId, stayId);
        const { rows } = await tx.execute<Omit<DocumentRow, 'content'>>(sql`
          SELECT d.id, d.kind, d.number, d.issued_at
            FROM folio_document d JOIN folio f ON f.id = d.folio_id AND f.property_id = d.property_id
           WHERE d.property_id = ${propertyId} AND f.stay_id = ${stayId}
           ORDER BY d.issued_at, d.number`);
        return rows.map((r) => ({ id: r.id, kind: r.kind, number: r.number, issuedAt: new Date(r.issued_at).toISOString() }));
      },
      { accessMode: 'read only' },
    );
  }

  /** One document as it was issued. */
  async get(id: string): Promise<DocumentView> {
    if (!isUuid(id)) throw documentNotFound();
    const propertyId = await this.property.id();
    return this.db.transaction((tx) => this.byId(tx, propertyId, id), { accessMode: 'read only' });
  }

  private async byId(tx: Tx, propertyId: string, id: string): Promise<DocumentView> {
    const { rows } = await tx.execute<DocumentRow>(sql`
      SELECT id, kind, number, issued_at, content FROM folio_document WHERE id = ${id} AND property_id = ${propertyId}`);
    const r = rows[0];
    if (!r) throw documentNotFound();
    return { id: r.id, kind: r.kind, number: r.number, issuedAt: new Date(r.issued_at).toISOString(), content: r.content };
  }

  private async stay(tx: Tx, propertyId: string, stayId: string): Promise<{ status: string }> {
    const { rows } = await tx.execute<{ status: string }>(
      sql`SELECT status FROM stay WHERE id = ${stayId} AND property_id = ${propertyId}`,
    );
    if (!rows[0]) throw stayNotFound();
    return rows[0];
  }

  /** Everything of the content but its number, kind and dates, read under the locked folio. */
  private async contentOf(
    tx: Tx,
    propertyId: string,
    stayId: string,
    folioId: string,
    kind: DocumentKind,
  ): Promise<Omit<DocumentContent, 'kind' | 'number' | 'issuedAt' | 'businessDate' | 'notice'>> {
    const posted: DocumentLine[] = (await this.folio.folioLines(tx, propertyId, folioId)).map((l) => ({
      description: l.description,
      night: l.night,
      amountMinor: l.amountMinor,
      vatRateBp: l.vatRateBp,
      expected: false,
    }));
    const lines = [...posted];
    if (kind === 'proforma') {
      const { status } = await this.stay(tx, propertyId, stayId);
      if (CHARGEABLE.has(status)) {
        const { accommodationVatBp } = await this.settings.read(tx, propertyId);
        for (const n of await this.folio.unpostedNights(tx, propertyId, stayId)) {
          lines.push({ description: nightDescription(n.night), night: n.night, amountMinor: n.priceMinor, vatRateBp: accommodationVatBp, expected: true });
        }
      }
    }
    const payments = (await this.folio.folioPayments(tx, propertyId, folioId)).map((p) => ({
      method: p.method,
      amountMinor: p.amountMinor,
      businessDate: p.businessDate,
    }));

    const profile = await this.legal.get();
    const seller = {
      legalName: profile.legalName ?? null,
      taxId: profile.taxId ?? null,
      registryId: profile.registryId ?? null,
      address: profile.address ?? null,
      postalCode: profile.postalCode ?? null,
      city: profile.city ?? null,
      bankAccount: profile.bankAccount ?? null,
      vatPayer: profile.vatPayer === true,
    };

    const { rows } = await tx.execute<{
      number: string;
      arrival: string;
      departure: string;
      unit: string | null;
      first_name: string;
      last_name: string;
      email: string | null;
    }>(sql`
      SELECT r.number, s.arrival::text AS arrival, s.departure::text AS departure, u.name AS unit,
             coalesce(pg.first_name, hg.first_name) AS first_name, coalesce(pg.last_name, hg.last_name) AS last_name,
             (CASE WHEN pg.id IS NULL THEN hg.email ELSE pg.email END)::text AS email
        FROM stay s
        JOIN reservation r ON r.id = s.reservation_id AND r.property_id = s.property_id
        JOIN guest hg ON hg.id = r.holder_guest_id AND hg.property_id = r.property_id
        LEFT JOIN unit u ON u.id = s.unit_id AND u.property_id = s.property_id
        LEFT JOIN stay_guest sg ON sg.stay_id = s.id AND sg.property_id = s.property_id AND sg.is_primary
        LEFT JOIN guest pg ON pg.id = sg.guest_id AND pg.property_id = sg.property_id
       WHERE s.id = ${stayId} AND s.property_id = ${propertyId}`);
    const r = rows[0];

    const total = sum(lines.map((l) => l.amountMinor));
    const paid = sum(payments.map((p) => p.amountMinor));
    return {
      seller,
      guest: { name: `${r.first_name} ${r.last_name}`, email: r.email },
      reservation: { number: r.number, arrival: r.arrival, departure: r.departure, unit: r.unit },
      lines,
      payments,
      totalMinor: total.amount_minor,
      paidMinor: paid.amount_minor,
      dueMinor: subtract(total, paid).amount_minor,
      vat: vatOf(lines, seller.vatPayer),
    };
  }
}
