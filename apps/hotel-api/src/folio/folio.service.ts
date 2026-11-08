import { Inject, Injectable } from '@nestjs/common';
import { fromMinor, negate, subtract } from '@platform/money';
import { sql, type SQL } from 'drizzle-orm';
import { BusinessDayService } from '../business-day/business-day.service';
import { SettingsService } from '../business-day/settings.service';
import { AuditService } from '../common/audit.service';
import { DomainError } from '../common/domain-error';
import { parseKey, requestHash } from '../common/idempotency';
import { asBody, isUniqueViolation, isUuid, optionalText, requireOneOf, requireText, validationFailed, type Body } from '../common/input';
import { PropertyContext } from '../common/property-context';
import { DB, type Db, type Tx } from '../db/tokens';
import type { Actor } from '../reservations/reservations.service';

// The folio of a stay (spec 5.5): its lines (charges, nights, corrections)
// and its payments (payments, refunds, voids). Append-only: rows are never
// changed or deleted (trigger in 0010); a correction reverses a line, a void
// reverses a payment. The balance is lines minus payments, computed in SQL
// under the locked folio row, never stored.
//
// Every writing transaction takes its locks in the global order
// (constraints): the open business_day row FOR SHARE (lockOpen, which also
// gives the posting's business date), then for a charge the reservation row
// FOR SHARE (preflight F22: a cancel holds it FOR UPDATE), then the folio row
// FOR UPDATE (ensureFolio, or by id for a reversal or void). Under the folio
// lock, in this order: the request key is looked up (a retry returns the
// first result before any rule could refuse it), then folio_closed, then the
// rules of the operation, then the insert.
//
// Request keys are unique per property in folio_line and in payment
// separately, so a key is looked up in both (Task 8 adds folio_document to
// findKey). Two requests with one key on the same folio meet at the folio
// lock and the second finds the first; on two folios the second insert hits
// the unique index, which write() turns into 409 idempotency_key_reused.

export interface LineView {
  id: string;
  kind: string;
  description: string;
  amountMinor: number;
  vatRateBp: number | null;
  businessDate: string;
  night: string | null;
  sourceType: string;
  reversesLineId: string | null;
  /** The correction that reverses this line. */
  reversedBy: string | null;
  reason: string | null;
  createdAt: string;
}

export interface PaymentView {
  id: string;
  method: string;
  amountMinor: number;
  businessDate: string;
  reference: string | null;
  reversesPaymentId: string | null;
  /** The payment that voids this one. */
  voidedBy: string | null;
  reason: string | null;
  createdAt: string;
}

export interface FolioView {
  /** null while the stay has no folio (nothing was charged or paid yet). */
  id: string | null;
  stayId: string;
  reservationId: string;
  status: 'none' | 'open' | 'closed';
  lines: LineView[];
  payments: PaymentView[];
  chargesMinor: number;
  paymentsMinor: number;
  balanceMinor: number;
  /**
   * Nights of the stay (stay_night) without an accommodation line, at their
   * agreed price: for the pro forma and the check-out preview. Only for a
   * stay that is expected or in house, and only nights priced above 0 (a
   * night at 0 is never posted).
   */
  unpostedNights: Array<{ night: string; priceMinor: number }>;
  /** The VAT rates a manual charge may carry (property settings; preflight F38). */
  vatRatesBp: number[];
}

/** A write's answer: `created` false when the request key replayed an earlier result (200, not 201). */
export interface Written<T> {
  created: boolean;
  view: T;
}

export type NightSource = 'night_audit' | 'check_out' | 'no_show';

/**
 * A night the stay has no stay_night row for: a programming or data error,
 * not a user error. The night audit turns it into 409 close_failed and keeps
 * the day open (preflight F13).
 */
export class NightWithoutPrice extends Error {
  constructor(
    readonly stayId: string,
    readonly night: string,
  ) {
    super(`folio: stay ${stayId} has no stay_night row for ${night}`);
    this.name = 'NightWithoutPrice';
  }
}

/**
 * postNight was given a folio that is not the open folio of the stay (another
 * stay's, or closed): a caller bug (Ruling 31), never a user error.
 */
export class FolioNotOpen extends Error {
  constructor(
    readonly folioId: string,
    readonly stayId: string,
  ) {
    super(`folio: ${folioId} is not the open folio of stay ${stayId}`);
    this.name = 'FolioNotOpen';
  }
}

/** 100.000.000,00 RSD. */
export const MAX_AMOUNT_MINOR = 10_000_000_000;
const CURRENCY = 'RSD';
const CHARGE_KINDS = ['service', 'fee'] as const;
const PAY_METHODS = ['cash', 'card', 'transfer'] as const;
const CHARGEABLE: ReadonlySet<string> = new Set(['expected', 'in_house']);

const stayNotFound = () => new DomainError('stay_not_found', 'Boravak ne postoji.', 404);
const lineNotFound = () => new DomainError('line_not_found', 'Stavka folija ne postoji.', 404);
const paymentNotFound = () => new DomainError('payment_not_found', 'Plaćanje ne postoji.', 404);
const folioClosed = () => new DomainError('folio_closed', 'Folio je zatvoren i ne prima nove stavke ni plaćanja.', 409);
const keyReused = () =>
  new DomainError('idempotency_key_reused', 'Ključ zahteva je već upotrebljen za drugi zahtev.', 409);

/** An integer 1 ≤ n ≤ 10_000_000_000; otherwise 422 naming amountMinor. */
function amountOf(b: Body): number {
  const v = b.amountMinor;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_AMOUNT_MINOR) throw validationFailed('amountMinor');
  return v;
}

function minorFrom(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error(`folio: amount ${raw} is not a safe integer`);
  return n;
}

/** 'Smeštaj 2.11.2026' for night 2026-11-02. */
function nightDescription(night: string): string {
  const [y, m, d] = night.split('-').map(Number);
  return `Smeštaj ${d}.${m}.${y}`;
}

function constraintOf(err: unknown): string | undefined {
  const e = err as { constraint?: string; cause?: { constraint?: string } } | null;
  return e?.constraint ?? e?.cause?.constraint;
}

type LineRow = {
  id: string;
  kind: string;
  description: string;
  amount_minor: string;
  vat_rate_bp: number | null;
  business_date: string;
  night: string | null;
  source_type: string;
  reverses_line_id: string | null;
  reversed_by: string | null;
  reason: string | null;
  created_at: string | Date;
};

type PaymentRow = {
  id: string;
  method: string;
  amount_minor: string;
  business_date: string;
  reference: string | null;
  reverses_payment_id: string | null;
  voided_by: string | null;
  reason: string | null;
  created_at: string | Date;
};

function lineView(r: LineRow): LineView {
  return {
    id: r.id,
    kind: r.kind,
    description: r.description,
    amountMinor: minorFrom(r.amount_minor),
    vatRateBp: r.vat_rate_bp,
    businessDate: r.business_date,
    night: r.night,
    sourceType: r.source_type,
    reversesLineId: r.reverses_line_id,
    reversedBy: r.reversed_by,
    reason: r.reason,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function paymentView(r: PaymentRow): PaymentView {
  return {
    id: r.id,
    method: r.method,
    amountMinor: minorFrom(r.amount_minor),
    businessDate: r.business_date,
    reference: r.reference,
    reversesPaymentId: r.reverses_payment_id,
    voidedBy: r.voided_by,
    reason: r.reason,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

type StayRow = { id: string; reservation_id: string; status: string };
type LockedFolio = { id: string; status: 'open' | 'closed' };

@Injectable()
export class FolioService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly property: PropertyContext,
    private readonly days: BusinessDayService,
    private readonly settings: SettingsService,
  ) {}

  // ---- building blocks for check-in/out and the night audit (Tasks 5-6) ----

  /**
   * The stay's folio, created when missing, locked FOR UPDATE until the end
   * of `tx` (lock order point 6). 404 stay_not_found when the stay does not exist.
   */
  async ensureFolio(tx: Tx, propertyId: string, stayId: string): Promise<{ id: string; status: 'open' | 'closed' }> {
    await tx.execute(sql`
      INSERT INTO folio (property_id, stay_id, reservation_id)
      SELECT property_id, id, reservation_id FROM stay WHERE id = ${stayId} AND property_id = ${propertyId}
      ON CONFLICT (property_id, stay_id) DO NOTHING`);
    const { rows } = await tx.execute<LockedFolio>(sql`
      SELECT id, status FROM folio WHERE property_id = ${propertyId} AND stay_id = ${stayId} FOR UPDATE`);
    if (!rows[0]) throw stayNotFound();
    return rows[0];
  }

  /**
   * Lines minus payments of a folio, in one statement. Call with the folio
   * row locked (or in a read-only transaction, for display).
   */
  async balanceOf(tx: Tx, folioId: string): Promise<{ chargesMinor: number; paymentsMinor: number; balanceMinor: number }> {
    const { rows } = await tx.execute<{ charges: string; payments: string }>(sql`
      SELECT (SELECT coalesce(sum(l.amount_minor), 0) FROM folio_line l
               WHERE l.folio_id = f.id AND l.property_id = f.property_id)::text AS charges,
             (SELECT coalesce(sum(p.amount_minor), 0) FROM payment p
               WHERE p.folio_id = f.id AND p.property_id = f.property_id)::text AS payments
        FROM folio f WHERE f.id = ${folioId}`);
    if (!rows[0]) throw new Error(`folio: ${folioId} not found`);
    const charges = fromMinor(minorFrom(rows[0].charges), CURRENCY);
    const payments = fromMinor(minorFrom(rows[0].payments), CURRENCY);
    return {
      chargesMinor: charges.amount_minor,
      paymentsMinor: payments.amount_minor,
      balanceMinor: subtract(charges, payments).amount_minor,
    };
  }

  /**
   * Posts one night of a stay at its agreed price (stay_night) with the
   * accommodation VAT of the settings. At most once per folio and night
   * (folio_line_night): returns false when the night was already posted, or
   * is priced 0 (amount_minor <> 0). A night without a stay_night row throws
   * NightWithoutPrice; a folio that is not the stay's open folio throws
   * FolioNotOpen (Ruling 31). Call under the shared business-day lock with the
   * folio locked; `businessDate` is what lockOpen returned.
   */
  async postNight(
    tx: Tx,
    propertyId: string,
    folioId: string,
    stay: { id: string },
    night: string,
    businessDate: string,
    source: NightSource,
  ): Promise<boolean> {
    const { rows } = await tx.execute<{ price_minor: string }>(sql`
      SELECT price_minor::text AS price_minor FROM stay_night
       WHERE property_id = ${propertyId} AND stay_id = ${stay.id} AND day = ${night}::date`);
    if (!rows[0]) throw new NightWithoutPrice(stay.id, night);
    const price = minorFrom(rows[0].price_minor);
    if (price === 0) return false;
    const { accommodationVatBp } = await this.settings.read(tx, propertyId);
    // source_id (preflight F23c): the business day for the night audit, the stay otherwise.
    const sourceId = source === 'night_audit' ? businessDate : stay.id;
    // Only into the open folio of this stay (Ruling 31): a folio of another
    // stay or a closed one gets no row, and the check below refuses it.
    const { rows: inserted } = await tx.execute(sql`
      INSERT INTO folio_line (property_id, folio_id, kind, description, amount_minor, vat_rate_bp, business_date, night,
                              source_type, source_id)
      SELECT f.property_id, f.id, 'accommodation', ${nightDescription(night)}, ${price}, ${accommodationVatBp}::int,
             ${businessDate}::date, ${night}::date, ${source}, ${sourceId}
        FROM folio f
       WHERE f.id = ${folioId} AND f.property_id = ${propertyId} AND f.stay_id = ${stay.id} AND f.status = 'open'
      ON CONFLICT (folio_id, night) WHERE kind = 'accommodation' DO NOTHING
      RETURNING id`);
    if (inserted.length > 0) return true;
    const { rows: own } = await tx.execute(sql`
      SELECT 1 FROM folio
       WHERE id = ${folioId} AND property_id = ${propertyId} AND stay_id = ${stay.id} AND status = 'open'`);
    if (!own[0]) throw new FolioNotOpen(folioId, stay.id);
    return false;
  }

  // ---- reading ----

  /** The folio of a stay, in one read-only snapshot; a stay without a folio gets an empty one (nothing is created). */
  async view(stayId: string): Promise<FolioView> {
    if (!isUuid(stayId)) throw stayNotFound();
    const propertyId = await this.property.id();
    return this.db.transaction(
      async (tx) => {
        const stay = await this.stay(tx, propertyId, stayId);
        const { rows: folios } = await tx.execute<{ id: string; status: 'open' | 'closed' }>(sql`
          SELECT id, status FROM folio WHERE property_id = ${propertyId} AND stay_id = ${stayId}`);
        const folio = folios[0];
        const { vatRatesBp } = await this.settings.read(tx, propertyId);
        const unpostedNights = CHARGEABLE.has(stay.status) ? await this.unpostedNights(tx, propertyId, stayId) : [];
        const base = { stayId, reservationId: stay.reservation_id, unpostedNights, vatRatesBp };
        if (!folio) {
          return { ...base, id: null, status: 'none', lines: [], payments: [], chargesMinor: 0, paymentsMinor: 0, balanceMinor: 0 };
        }
        return {
          ...base,
          id: folio.id,
          status: folio.status,
          lines: await this.lines(tx, propertyId, sql`l.folio_id = ${folio.id}`),
          payments: await this.payments(tx, propertyId, sql`p.folio_id = ${folio.id}`),
          ...(await this.balanceOf(tx, folio.id)),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  // ---- writing ----

  /** A manual charge (service or fee) on a stay that is expected or in house. */
  async charge(stayId: string, raw: unknown, actor: Actor): Promise<Written<LineView>> {
    const b = asBody(raw);
    const kind = requireOneOf(b, 'kind', CHARGE_KINDS);
    const description = requireText(b, 'description', 200);
    const amountMinor = amountOf(b);
    // Absent and null are the same: no rate. A rate must also be one of the settings' rates (checked in the transaction).
    const rawVat = b.vatRateBp ?? null;
    if (rawVat !== null && (typeof rawVat !== 'number' || !Number.isInteger(rawVat))) throw validationFailed('vatRateBp');
    const vatRateBp = rawVat as number | null;
    const key = parseKey(b);
    if (!isUuid(stayId)) throw stayNotFound();
    const propertyId = await this.property.id();
    const hash = requestHash('folio.charge', stayId, { kind, description, amountMinor, vatRateBp });

    return this.write(async (tx) => {
      const businessDate = await this.days.lockOpen(tx, propertyId, 'share');
      const found = await this.stay(tx, propertyId, stayId);
      // Lock order point 1 (preflight F22): a cancel holds this row FOR UPDATE,
      // so the stay's status is read after it, not before.
      await tx.execute(sql`
        SELECT 1 FROM reservation WHERE id = ${found.reservation_id} AND property_id = ${propertyId} FOR SHARE`);
      const { status } = await this.stay(tx, propertyId, stayId);
      const folio = await this.ensureFolio(tx, propertyId, stayId);
      const replayed = await this.replay(tx, propertyId, key, 'folio_line', hash);
      if (replayed) return { created: false, view: await this.line(tx, propertyId, replayed) };
      if (folio.status === 'closed') throw folioClosed();
      if (!CHARGEABLE.has(status)) {
        throw new DomainError('stay_not_chargeable', 'Na boravak u ovom stanju ne mogu se dodavati zaduženja.', 409, { status });
      }
      if (vatRateBp !== null && !(await this.settings.read(tx, propertyId)).vatRatesBp.includes(vatRateBp)) {
        throw validationFailed('vatRateBp', 'PDV stopa nije među stopama u podešavanjima objekta.');
      }
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO folio_line (property_id, folio_id, kind, description, amount_minor, vat_rate_bp, business_date,
                                source_type, idempotency_key, request_hash, created_by)
        VALUES (${propertyId}, ${folio.id}, ${kind}, ${description}, ${amountMinor}, ${vatRateBp}::int, ${businessDate}::date,
                'manual', ${key}, ${hash}, ${actor.id})
        RETURNING id`);
      const id = rows[0].id;
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'folio.charge',
        entity: 'folio_line',
        entityId: id,
        after: { folioId: folio.id, stayId, kind, description, amountMinor, vatRateBp, businessDate },
      });
      return { created: true, view: await this.line(tx, propertyId, id) };
    });
  }

  /** A correction: a new line of −amount that reverses `lineId`, with the original's VAT rate (preflight F26). */
  async reverseLine(lineId: string, raw: unknown, actor: Actor): Promise<Written<LineView>> {
    const b = asBody(raw);
    const reason = requireText(b, 'reason', 500);
    const key = parseKey(b);
    if (!isUuid(lineId)) throw lineNotFound();
    const propertyId = await this.property.id();
    const hash = requestHash('folio.reverse', lineId, { reason });

    return this.write(async (tx) => {
      const businessDate = await this.days.lockOpen(tx, propertyId, 'share');
      const { rows: lines } = await tx.execute<{
        folio_id: string;
        kind: string;
        description: string;
        amount_minor: string;
        vat_rate_bp: number | null;
      }>(sql`
        SELECT folio_id, kind, description, amount_minor::text AS amount_minor, vat_rate_bp
          FROM folio_line WHERE id = ${lineId} AND property_id = ${propertyId}`);
      const original = lines[0];
      if (!original) throw lineNotFound();
      const folio = await this.lockFolio(tx, propertyId, original.folio_id);
      const replayed = await this.replay(tx, propertyId, key, 'folio_line', hash);
      if (replayed) return { created: false, view: await this.line(tx, propertyId, replayed) };
      if (folio.status === 'closed') throw folioClosed();
      if (original.kind === 'correction') {
        throw new DomainError('cannot_reverse_correction', 'Storno stavka se ne može stornirati.', 422);
      }
      const { rows: reversed } = await tx.execute(sql`
        SELECT 1 FROM folio_line WHERE property_id = ${propertyId} AND reverses_line_id = ${lineId}`);
      if (reversed[0]) throw new DomainError('line_already_reversed', 'Stavka je već stornirana.', 409);
      const amountMinor = negate(fromMinor(minorFrom(original.amount_minor), CURRENCY)).amount_minor;
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO folio_line (property_id, folio_id, kind, description, amount_minor, vat_rate_bp, business_date,
                                source_type, reverses_line_id, reason, idempotency_key, request_hash, created_by)
        VALUES (${propertyId}, ${folio.id}, 'correction', ${`Storno: ${original.description}`}, ${amountMinor},
                ${original.vat_rate_bp}::int, ${businessDate}::date, 'reversal', ${lineId}, ${reason}, ${key}, ${hash}, ${actor.id})
        RETURNING id`);
      const id = rows[0].id;
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'folio.reverse',
        entity: 'folio_line',
        entityId: id,
        after: { folioId: folio.id, reversesLineId: lineId, amountMinor, businessDate, reason },
      });
      return { created: true, view: await this.line(tx, propertyId, id) };
    });
  }

  /** A payment, on a stay in any status; more than the balance is allowed (the balance goes negative: a credit). */
  async pay(stayId: string, raw: unknown, actor: Actor): Promise<Written<PaymentView>> {
    const b = asBody(raw);
    const method = requireOneOf(b, 'method', PAY_METHODS);
    const amountMinor = amountOf(b);
    const reference = optionalText(b, 'reference', 100) ?? null;
    const key = parseKey(b);
    if (!isUuid(stayId)) throw stayNotFound();
    const propertyId = await this.property.id();
    const hash = requestHash('folio.pay', stayId, { method, amountMinor, reference });

    return this.write(async (tx) => {
      const businessDate = await this.days.lockOpen(tx, propertyId, 'share');
      const folio = await this.ensureFolio(tx, propertyId, stayId);
      const replayed = await this.replay(tx, propertyId, key, 'payment', hash);
      if (replayed) return { created: false, view: await this.payment(tx, propertyId, replayed) };
      if (folio.status === 'closed') throw folioClosed();
      const id = await this.insertPayment(tx, {
        propertyId,
        folioId: folio.id,
        method,
        amountMinor,
        businessDate,
        reference,
        reversesPaymentId: null,
        reason: null,
        key,
        hash,
        actor,
      });
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'folio.pay',
        entity: 'payment',
        entityId: id,
        after: { folioId: folio.id, stayId, method, amountMinor, reference, businessDate },
      });
      return { created: true, view: await this.payment(tx, propertyId, id) };
    });
  }

  /** Money back: a payment of −amountMinor, only out of a credit (negative balance) and at most all of it. */
  async refund(stayId: string, raw: unknown, actor: Actor): Promise<Written<PaymentView>> {
    const b = asBody(raw);
    const method = requireOneOf(b, 'method', PAY_METHODS);
    const amountMinor = amountOf(b);
    const reason = requireText(b, 'reason', 500);
    const key = parseKey(b);
    if (!isUuid(stayId)) throw stayNotFound();
    const propertyId = await this.property.id();
    const hash = requestHash('folio.refund', stayId, { method, amountMinor, reason });

    return this.write(async (tx) => {
      const businessDate = await this.days.lockOpen(tx, propertyId, 'share');
      const folio = await this.ensureFolio(tx, propertyId, stayId);
      const replayed = await this.replay(tx, propertyId, key, 'payment', hash);
      if (replayed) return { created: false, view: await this.payment(tx, propertyId, replayed) };
      if (folio.status === 'closed') throw folioClosed();
      const { balanceMinor } = await this.balanceOf(tx, folio.id);
      const creditMinor = balanceMinor < 0 ? -balanceMinor : 0;
      if (amountMinor > creditMinor) {
        throw new DomainError('refund_exceeds_credit', 'Povraćaj ne može biti veći od preplate na foliju.', 422, { creditMinor });
      }
      const refunded = negate(fromMinor(amountMinor, CURRENCY)).amount_minor;
      const id = await this.insertPayment(tx, {
        propertyId,
        folioId: folio.id,
        method,
        amountMinor: refunded,
        businessDate,
        reference: null,
        reversesPaymentId: null,
        reason,
        key,
        hash,
        actor,
      });
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'folio.refund',
        entity: 'payment',
        entityId: id,
        after: { folioId: folio.id, stayId, method, amountMinor: refunded, businessDate, reason },
      });
      return { created: true, view: await this.payment(tx, propertyId, id) };
    });
  }

  /** A void: a payment of −amount, same method, that reverses `paymentId`. */
  async voidPayment(paymentId: string, raw: unknown, actor: Actor): Promise<Written<PaymentView>> {
    const b = asBody(raw);
    const reason = requireText(b, 'reason', 500);
    const key = parseKey(b);
    if (!isUuid(paymentId)) throw paymentNotFound();
    const propertyId = await this.property.id();
    const hash = requestHash('folio.void', paymentId, { reason });

    return this.write(async (tx) => {
      const businessDate = await this.days.lockOpen(tx, propertyId, 'share');
      const { rows: found } = await tx.execute<{
        folio_id: string;
        method: string;
        amount_minor: string;
        reverses_payment_id: string | null;
      }>(sql`
        SELECT folio_id, method, amount_minor::text AS amount_minor, reverses_payment_id
          FROM payment WHERE id = ${paymentId} AND property_id = ${propertyId}`);
      const original = found[0];
      if (!original) throw paymentNotFound();
      const folio = await this.lockFolio(tx, propertyId, original.folio_id);
      const replayed = await this.replay(tx, propertyId, key, 'payment', hash);
      if (replayed) return { created: false, view: await this.payment(tx, propertyId, replayed) };
      if (folio.status === 'closed') throw folioClosed();
      if (original.reverses_payment_id !== null) {
        throw new DomainError('cannot_void_reversal', 'Storno plaćanja se ne može stornirati.', 422);
      }
      const { rows: voided } = await tx.execute(sql`
        SELECT 1 FROM payment WHERE property_id = ${propertyId} AND reverses_payment_id = ${paymentId}`);
      if (voided[0]) throw new DomainError('payment_already_voided', 'Plaćanje je već stornirano.', 409);
      const amountMinor = negate(fromMinor(minorFrom(original.amount_minor), CURRENCY)).amount_minor;
      const id = await this.insertPayment(tx, {
        propertyId,
        folioId: folio.id,
        method: original.method,
        amountMinor,
        businessDate,
        reference: null,
        reversesPaymentId: paymentId,
        reason,
        key,
        hash,
        actor,
      });
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'folio.void',
        entity: 'payment',
        entityId: id,
        after: { folioId: folio.id, reversesPaymentId: paymentId, method: original.method, amountMinor, businessDate, reason },
      });
      return { created: true, view: await this.payment(tx, propertyId, id) };
    });
  }

  // ---- helpers ----

  /**
   * Runs a writing transaction. A request key that reached the unique index
   * of its table first through another transaction (another folio: the folio
   * lock does not serialise them) is 409 idempotency_key_reused.
   */
  private async write<T>(fn: (tx: Tx) => Promise<Written<T>>): Promise<Written<T>> {
    try {
      return await this.db.transaction(fn);
    } catch (err) {
      const constraint = constraintOf(err);
      if (isUniqueViolation(err) && (constraint === 'folio_line_key' || constraint === 'payment_key')) throw keyReused();
      throw err;
    }
  }

  /** Where a request key was used: one lookup across the tables that hold keys. */
  private async findKey(
    tx: Tx,
    propertyId: string,
    key: string,
  ): Promise<{ source: 'folio_line' | 'payment'; id: string; request_hash: string } | null> {
    const { rows } = await tx.execute<{ source: 'folio_line' | 'payment'; id: string; request_hash: string }>(sql`
      SELECT 'folio_line' AS source, id, request_hash FROM folio_line
       WHERE property_id = ${propertyId} AND idempotency_key = ${key}
      UNION ALL
      SELECT 'payment' AS source, id, request_hash FROM payment
       WHERE property_id = ${propertyId} AND idempotency_key = ${key}`);
    return rows[0] ?? null;
  }

  /**
   * The id of the earlier result of this request (same key, same table, same
   * hash), null for a new key; 409 idempotency_key_reused when the key was
   * used for anything else.
   */
  private async replay(tx: Tx, propertyId: string, key: string, source: 'folio_line' | 'payment', hash: string): Promise<string | null> {
    const found = await this.findKey(tx, propertyId, key);
    if (!found) return null;
    if (found.source !== source || found.request_hash !== hash) throw keyReused();
    return found.id;
  }

  private async stay(tx: Tx, propertyId: string, stayId: string): Promise<StayRow> {
    const { rows } = await tx.execute<StayRow>(
      sql`SELECT id, reservation_id, status FROM stay WHERE id = ${stayId} AND property_id = ${propertyId}`,
    );
    if (!rows[0]) throw stayNotFound();
    return rows[0];
  }

  private async lockFolio(tx: Tx, propertyId: string, folioId: string): Promise<LockedFolio> {
    const { rows } = await tx.execute<LockedFolio>(
      sql`SELECT id, status FROM folio WHERE id = ${folioId} AND property_id = ${propertyId} FOR UPDATE`,
    );
    if (!rows[0]) throw new Error(`folio: ${folioId} not found`);
    return rows[0];
  }

  private async insertPayment(
    tx: Tx,
    p: {
      propertyId: string;
      folioId: string;
      method: string;
      amountMinor: number;
      businessDate: string;
      reference: string | null;
      reversesPaymentId: string | null;
      reason: string | null;
      key: string;
      hash: string;
      actor: Actor;
    },
  ): Promise<string> {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO payment (property_id, folio_id, method, amount_minor, business_date, reference, reverses_payment_id,
                           reason, idempotency_key, request_hash, created_by)
      VALUES (${p.propertyId}, ${p.folioId}, ${p.method}, ${p.amountMinor}, ${p.businessDate}::date, ${p.reference},
              ${p.reversesPaymentId}::uuid, ${p.reason}, ${p.key}, ${p.hash}, ${p.actor.id})
      RETURNING id`);
    return rows[0].id;
  }

  private async lines(tx: Tx, propertyId: string, where: SQL): Promise<LineView[]> {
    const { rows } = await tx.execute<LineRow>(sql`
      SELECT l.id, l.kind, l.description, l.amount_minor::text AS amount_minor, l.vat_rate_bp,
             l.business_date::text AS business_date, l.night::text AS night, l.source_type, l.reverses_line_id,
             r.id AS reversed_by, l.reason, l.created_at
        FROM folio_line l
        LEFT JOIN folio_line r ON r.reverses_line_id = l.id AND r.property_id = l.property_id
       WHERE l.property_id = ${propertyId} AND ${where}
       ORDER BY l.created_at, l.night NULLS LAST, l.id`);
    return rows.map(lineView);
  }

  private async line(tx: Tx, propertyId: string, id: string): Promise<LineView> {
    const [view] = await this.lines(tx, propertyId, sql`l.id = ${id}`);
    return view;
  }

  private async payments(tx: Tx, propertyId: string, where: SQL): Promise<PaymentView[]> {
    const { rows } = await tx.execute<PaymentRow>(sql`
      SELECT p.id, p.method, p.amount_minor::text AS amount_minor, p.business_date::text AS business_date, p.reference,
             p.reverses_payment_id, v.id AS voided_by, p.reason, p.created_at
        FROM payment p
        LEFT JOIN payment v ON v.reverses_payment_id = p.id AND v.property_id = p.property_id
       WHERE p.property_id = ${propertyId} AND ${where}
       ORDER BY p.created_at, p.id`);
    return rows.map(paymentView);
  }

  private async payment(tx: Tx, propertyId: string, id: string): Promise<PaymentView> {
    const [view] = await this.payments(tx, propertyId, sql`p.id = ${id}`);
    return view;
  }

  /**
   * The stay's agreed nights (stay_night) priced above 0 that have no
   * accommodation line yet, by night; with `before`, only nights before that
   * day. The folio view lists them; check-out and its preview post them
   * (StayLifecycleService), so both read the same rule.
   */
  async unpostedNights(
    tx: Tx,
    propertyId: string,
    stayId: string,
    before?: string,
  ): Promise<Array<{ night: string; priceMinor: number }>> {
    const { rows } = await tx.execute<{ night: string; price_minor: string }>(sql`
      SELECT n.day::text AS night, n.price_minor::text AS price_minor
        FROM stay_night n
       WHERE n.property_id = ${propertyId} AND n.stay_id = ${stayId} AND n.price_minor > 0
         ${before === undefined ? sql`` : sql`AND n.day < ${before}::date`}
         AND NOT EXISTS (
               SELECT 1 FROM folio_line l JOIN folio f ON f.id = l.folio_id AND f.property_id = l.property_id
                WHERE f.property_id = n.property_id AND f.stay_id = n.stay_id
                  AND l.kind = 'accommodation' AND l.night = n.day)
       ORDER BY n.day`);
    return rows.map((r) => ({ night: r.night, priceMinor: minorFrom(r.price_minor) }));
  }
}
