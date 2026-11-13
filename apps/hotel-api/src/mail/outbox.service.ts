import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { AuditService } from '../common/audit.service';
import { CLOCK, type Clock } from '../common/clock';
import { DomainError } from '../common/domain-error';
import { isUuid } from '../common/input';
import { PropertyContext } from '../common/property-context';
import { DB, type Db, type Tx } from '../db/tokens';
import type { ReservationPayload, ReservationPayloadStay, Template } from './templates';

export type MessageStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

export interface EnqueueInput {
  template: Template;
  reservationId: string;
  /** The guest's address; null: the message is stored as skipped. */
  recipient: string | null;
  payload: ReservationPayload;
  key: string;
}

export interface MessageView {
  id: string;
  template: Template;
  recipient: string | null;
  status: MessageStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  sentAt: string | null;
  history: Array<{ at: string; ok: boolean; error: string | null }>;
}

export const NO_RECIPIENT_REASON = 'Gost nema e-adresu.';
/** `last_error` of a confirmation closed because its reservation was cancelled (status `skipped`, recipient kept). */
export const RESERVATION_CANCELLED_REASON = 'Rezervacija je otkazana, pa potvrda nije poslata.';
const RESERVATION_CANCELLED_TEXT = 'Rezervacija je otkazana, pa potvrda ne može da se pošalje.';

/** One message per reservation and template: the idempotency key of the outbox row. */
export const messageKey = (template: Template, reservationId: string): string => `${template}:${reservationId}`;

const messageNotFound = () => new DomainError('message_not_found', 'Poruka ne postoji.', 404);
const reservationNotFound = () => new DomainError('reservation_not_found', 'Rezervacija ne postoji.', 404);

function minorFrom(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error(`outbox: amount ${raw} is not a safe integer`);
  return n;
}

type MessageRow = {
  id: string;
  template: Template;
  recipient: string | null;
  status: MessageStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date | string;
  sent_at: Date | string | null;
};

/**
 * The outbox: messages are written in the transaction of the change they
 * report (enqueue) and sent later by OutboxDispatcher. Every moment comes from
 * CLOCK, never from the database's now().
 */
@Injectable()
export class OutboxService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly property: PropertyContext,
  ) {}

  /**
   * Stores one message in the caller's transaction. The same key twice stores
   * it once. Without a recipient the message is `skipped` and the dispatcher
   * never touches it.
   */
  async enqueue(tx: Tx, propertyId: string, e: EnqueueInput): Promise<void> {
    const status: MessageStatus = e.recipient === null ? 'skipped' : 'pending';
    await tx.execute(sql`
      INSERT INTO outbox_message (property_id, channel, template, idempotency_key, reservation_id, recipient, payload,
                                  status, next_attempt_at, last_error)
      VALUES (${propertyId}, 'email', ${e.template}, ${e.key}, ${e.reservationId}, ${e.recipient},
              ${JSON.stringify(e.payload)}::jsonb, ${status}, ${this.clock().toISOString()}::timestamptz,
              ${e.recipient === null ? NO_RECIPIENT_REASON : null})
      ON CONFLICT (property_id, idempotency_key) DO NOTHING`);
  }

  /** Reads the reservation as it is now (in the caller's transaction) and queues its confirmation or cancellation. */
  async enqueueReservation(tx: Tx, propertyId: string, template: Template, reservationId: string): Promise<void> {
    const { rows } = await tx.execute<{
      number: string;
      first_name: string;
      last_name: string;
      email: string | null;
      property_name: string;
      property_email: string | null;
      property_phone: string | null;
    }>(sql`
      SELECT r.number, g.first_name, g.last_name, g.email::text AS email,
             p.name AS property_name, lp.email AS property_email, lp.phone AS property_phone
        FROM reservation r
        JOIN guest g ON g.id = r.holder_guest_id AND g.property_id = r.property_id
        JOIN property p ON p.id = r.property_id
        LEFT JOIN legal_profile lp ON lp.property_id = r.property_id
       WHERE r.id = ${reservationId} AND r.property_id = ${propertyId}`);
    const r = rows[0];
    if (!r) throw new Error('outbox: reservation to report on is missing');
    const { rows: stayRows } = await tx.execute<{
      arrival: string;
      departure: string;
      adults: number;
      children: number;
      unit_type_name: string | null;
      unit_name: string | null;
      total: string;
    }>(sql`
      SELECT s.arrival::text AS arrival, s.departure::text AS departure, s.adults, s.children,
             ut.name ->> 'sr' AS unit_type_name, u.name AS unit_name,
             (SELECT COALESCE(SUM(n.price_minor), 0)::text FROM stay_night n
               WHERE n.stay_id = s.id AND n.property_id = s.property_id) AS total
        FROM stay s
        LEFT JOIN unit_type ut ON ut.id = s.unit_type_id AND ut.property_id = s.property_id
        LEFT JOIN unit u ON u.id = s.unit_id AND u.property_id = s.property_id
       WHERE s.property_id = ${propertyId} AND s.reservation_id = ${reservationId}
       ORDER BY s.arrival, s.departure, s.id`);
    const stays: ReservationPayloadStay[] = stayRows.map((s) => ({
      unitTypeName: s.unit_type_name,
      unitName: s.unit_name,
      arrival: s.arrival,
      departure: s.departure,
      adults: s.adults,
      children: s.children,
      totalMinor: minorFrom(s.total),
    }));
    const payload: ReservationPayload = {
      number: r.number,
      holderName: `${r.first_name} ${r.last_name}`,
      arrival: stays.reduce((min, s) => (s.arrival < min ? s.arrival : min), stays[0].arrival),
      departure: stays.reduce((max, s) => (s.departure > max ? s.departure : max), stays[0].departure),
      stays,
      totalMinor: stays.reduce((sum, s) => sum + s.totalMinor, 0),
      propertyName: r.property_name,
      propertyEmail: r.property_email,
      propertyPhone: r.property_phone,
    };
    await this.enqueue(tx, propertyId, {
      template,
      reservationId,
      recipient: r.email,
      payload,
      key: messageKey(template, reservationId),
    });
  }

  /**
   * Called by `cancel` after everything else it takes: closes every confirmation of the reservation that has not
   * gone out (pending or failed) as `skipped` with a fixed reason, so the guest never gets the confirmation after
   * the cancellation. One being sent right now (`sending`) and one already `sent` are left alone. The dispatcher
   * takes no reservation lock while it holds an outbox row, so the order reservation, then outbox rows, holds.
   */
  async closeConfirmations(tx: Tx, propertyId: string, reservationId: string): Promise<void> {
    await tx.execute(sql`
      UPDATE outbox_message
         SET status = 'skipped', lease_until = NULL, last_error = ${RESERVATION_CANCELLED_REASON}
       WHERE property_id = ${propertyId} AND reservation_id = ${reservationId}
         AND template = 'reservation_confirmed' AND status IN ('pending', 'failed')`);
  }

  // ---- reading ----

  /** The messages of one reservation, oldest first, each with its attempts. Writes nothing. */
  async forReservation(reservationId: string): Promise<MessageView[]> {
    if (!isUuid(reservationId)) throw reservationNotFound();
    const propertyId = await this.property.id();
    const { rows } = await this.db.execute<{ id: string }>(
      sql`SELECT id FROM reservation WHERE id = ${reservationId} AND property_id = ${propertyId}`,
    );
    if (!rows[0]) throw reservationNotFound();
    return this.views(this.db, propertyId, sql`m.reservation_id = ${reservationId}`);
  }

  private async views(db: Pick<Db, 'execute'>, propertyId: string, where: SQL): Promise<MessageView[]> {
    const { rows } = await db.execute<MessageRow>(sql`
      SELECT m.id, m.template, m.recipient, m.status, m.attempts, m.last_error, m.next_attempt_at, m.sent_at
        FROM outbox_message m
       WHERE m.property_id = ${propertyId} AND ${where}
       ORDER BY m.created_at, m.id`);
    const { rows: attempts } = await db.execute<{ message_id: string; at: Date | string; ok: boolean; error: string | null }>(sql`
      SELECT a.message_id, a.at, a.ok, a.error
        FROM outbox_attempt a JOIN outbox_message m ON m.id = a.message_id AND m.property_id = a.property_id
       WHERE a.property_id = ${propertyId} AND ${where}
       ORDER BY a.id`);
    return rows.map((m) => ({
      id: m.id,
      template: m.template,
      recipient: m.recipient,
      status: m.status,
      attempts: m.attempts,
      lastError: m.last_error,
      nextAttemptAt: new Date(m.next_attempt_at).toISOString(),
      sentAt: m.sent_at === null ? null : new Date(m.sent_at).toISOString(),
      history: attempts
        .filter((a) => a.message_id === m.id)
        .map((a) => ({ at: new Date(a.at).toISOString(), ok: a.ok, error: a.error })),
    }));
  }

  // ---- resend ----

  /**
   * Puts a failed or waiting message back in the queue, due now. A sent message
   * (409 message_already_sent) and one without a recipient (409
   * message_has_no_recipient) are refused; one being sent right now is left
   * alone (a second send would double it). A resent message keeps its attempt
   * count, so one more failure ends it as failed again.
   */
  async resend(id: string, actor: { id: string }): Promise<MessageView> {
    if (!isUuid(id)) throw messageNotFound();
    const propertyId = await this.property.id();
    await this.db.transaction(async (tx) => {
      // The row lock is load-bearing: the dispatcher's claim commits 'sending' under the same lock, and a resend
      // that read 'pending' before it must not write 'pending' after it (the message would go out twice).
      const { rows } = await tx.execute<{
        status: MessageStatus;
        attempts: number;
        template: Template;
        reservation_status: string | null;
      }>(sql`
        SELECT m.status, m.attempts, m.template, r.status AS reservation_status
          FROM outbox_message m
          LEFT JOIN reservation r ON r.id = m.reservation_id AND r.property_id = m.property_id
         WHERE m.id = ${id} AND m.property_id = ${propertyId}
           FOR UPDATE OF m`);
      const m = rows[0];
      if (!m) throw messageNotFound();
      if (m.status === 'sent') throw new DomainError('message_already_sent', 'Poruka je već poslata.', 409);
      if (m.template === 'reservation_confirmed' && m.reservation_status === 'cancelled') {
        throw new DomainError('message_reservation_cancelled', RESERVATION_CANCELLED_TEXT, 409);
      }
      if (m.status === 'skipped') {
        throw new DomainError('message_has_no_recipient', 'Gost nema e-adresu, pa poruka ne može da se pošalje.', 409);
      }
      if (m.status === 'sending') return;
      const { rows: moved } = await tx.execute<{ id: string }>(sql`
        UPDATE outbox_message SET status = 'pending', next_attempt_at = ${this.clock().toISOString()}::timestamptz
         WHERE id = ${id} AND property_id = ${propertyId} AND status IN ('pending', 'failed')
        RETURNING id`);
      // Cannot happen while the row is locked above; if it ever does, fail loudly instead of writing over a claim.
      if (moved.length === 0) throw new Error('outbox: resend found the message in another state than it locked');
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'message.resend',
        entity: 'outbox_message',
        entityId: id,
        before: { status: m.status, attempts: m.attempts },
        after: { status: 'pending' },
      });
    });
    return (await this.views(this.db, propertyId, sql`m.id = ${id}`))[0];
  }
}
