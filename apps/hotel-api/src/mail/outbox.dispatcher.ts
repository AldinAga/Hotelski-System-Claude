import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../common/clock';
import { DB, type Db } from '../db/tokens';
import { MAIL_FROM, MAIL_TRANSPORT, MailError, type MailTransport } from './mail-transport';
import { RESERVATION_CANCELLED_REASON } from './outbox.service';
import { render, type ReservationPayload, type Template } from './templates';

// Sends what the outbox holds (hotel-api process, started by main.ts after the
// migrations and the licence; tests call runOnce). A message is claimed in a
// short transaction (status 'sending' with a lease), sent outside any
// transaction, and its result is written in a second one. A process that dies
// in between leaves a 'sending' row whose lease runs out; the next run sends it
// again with the same Message-ID, so delivery is at least once.

/** Minutes to wait after the 1st..5th failed attempt; the 6th failure ends the message. */
export const BACKOFF_MINUTES = [1, 5, 30, 120, 360] as const;
export const LEASE_MINUTES = 5;
export const TICK_MS = 15_000;
const GENERIC_FAILURE = 'Slanje nije uspelo.';

export interface DispatchResult {
  sent: number;
  failed: number;
  retried: number;
}

type Claimed = {
  id: string;
  property_id: string;
  template: Template;
  recipient: string;
  payload: ReservationPayload;
  attempts: number;
};

const addMinutes = (at: Date, minutes: number): Date => new Date(at.getTime() + minutes * 60_000);

@Injectable()
export class OutboxDispatcher implements OnModuleDestroy {
  private readonly log = new Logger('OutboxDispatcher');
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    @Inject(MAIL_FROM) private readonly from: string,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // A run that outlasts the interval is not joined by a second one.
      if (this.ticking) return;
      this.ticking = true;
      this.runOnce()
        .catch((err: unknown) => this.log.error(`outbox run failed: ${err instanceof Error ? err.name : 'error'}`))
        .finally(() => {
          this.ticking = false;
        });
    }, TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** Sends up to `limit` due messages. Safe to run from several processes at once. */
  async runOnce(limit = 20): Promise<DispatchResult> {
    const claimed = await this.claim(limit);
    const result: DispatchResult = { sent: 0, failed: 0, retried: 0 };
    for (const m of claimed) {
      const outcome = await this.deliver(m);
      if (outcome !== null) result[outcome] += 1;
    }
    return result;
  }

  private async claim(limit: number): Promise<Claimed[]> {
    const now = this.clock();
    return this.db.transaction(async (tx) => {
      // The reservation is read, never locked: the dispatcher takes no reservation lock while it holds an outbox row.
      const { rows: due } = await tx.execute<Claimed & { reservation_status: string | null }>(sql`
        SELECT m.id, m.property_id, m.template, m.recipient, m.payload, m.attempts, r.status AS reservation_status
          FROM outbox_message m
          LEFT JOIN reservation r ON r.id = m.reservation_id AND r.property_id = m.property_id
         WHERE (m.status = 'pending' OR (m.status = 'sending' AND m.lease_until < ${now.toISOString()}::timestamptz))
           AND m.next_attempt_at <= ${now.toISOString()}::timestamptz
         ORDER BY m.next_attempt_at, m.id
           FOR UPDATE OF m SKIP LOCKED
         LIMIT ${limit}`);
      // A confirmation of a cancelled reservation is never handed out (Ruling 41): it is closed here, not left
      // waiting. A send already in flight at the moment of the cancel cannot be stopped.
      const rows: Claimed[] = [];
      for (const { reservation_status, ...m } of due) {
        if (m.template === 'reservation_confirmed' && reservation_status === 'cancelled') {
          await tx.execute(sql`
            UPDATE outbox_message SET status = 'skipped', lease_until = NULL, last_error = ${RESERVATION_CANCELLED_REASON}
             WHERE id = ${m.id} AND property_id = ${m.property_id}`);
          continue;
        }
        rows.push(m);
        await tx.execute(sql`
          UPDATE outbox_message
             SET status = 'sending', lease_until = ${addMinutes(now, LEASE_MINUTES).toISOString()}::timestamptz
           WHERE id = ${m.id} AND property_id = ${m.property_id}`);
      }
      return rows;
    });
  }

  private async deliver(m: Claimed): Promise<keyof DispatchResult | null> {
    let failure: MailError | null = null;
    try {
      const mail = render(m.template, m.payload, m.payload.propertyName);
      await this.transport.send({
        to: m.recipient,
        from: this.from,
        ...(m.payload.propertyEmail ? { replyTo: m.payload.propertyEmail } : {}),
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        messageId: `<${m.id}@hotel>`,
      });
    } catch (err) {
      // Only a MailError carries text meant for people; anything else is logged by name and stored as a generic line.
      if (err instanceof MailError) {
        failure = err;
      } else {
        this.log.warn(`message ${m.id}: unexpected ${err instanceof Error ? err.name : 'error'}`);
        failure = new MailError('send_failed', GENERIC_FAILURE, false);
      }
    }

    const at = this.clock();
    const attempts = m.attempts + 1;
    const atSql = sql`${at.toISOString()}::timestamptz`;
    // Each write needs status = 'sending'. That does not identify this claim: if another run took the message over
    // and is still sending, a late result from here still matches and the later one is dropped instead. It does stop
    // a result from overwriting a message that is already sent, failed or back in the queue (dropped: no attempt
    // row, not counted).
    return this.db.transaction(async (tx) => {
      let outcome: keyof DispatchResult;
      let moved: { rows: unknown[] };
      if (failure === null) {
        moved = await tx.execute(sql`
          UPDATE outbox_message SET status = 'sent', attempts = ${attempts}, sent_at = ${atSql}, lease_until = NULL, last_error = NULL
           WHERE id = ${m.id} AND property_id = ${m.property_id} AND status = 'sending'
          RETURNING id`);
        outcome = 'sent';
      } else if (failure.permanent || attempts > BACKOFF_MINUTES.length) {
        moved = await tx.execute(sql`
          UPDATE outbox_message SET status = 'failed', attempts = ${attempts}, lease_until = NULL, last_error = ${failure.message}
           WHERE id = ${m.id} AND property_id = ${m.property_id} AND status = 'sending'
          RETURNING id`);
        outcome = 'failed';
      } else {
        moved = await tx.execute(sql`
          UPDATE outbox_message
             SET status = 'pending', attempts = ${attempts}, lease_until = NULL, last_error = ${failure.message},
                 next_attempt_at = ${addMinutes(at, BACKOFF_MINUTES[attempts - 1]).toISOString()}::timestamptz
           WHERE id = ${m.id} AND property_id = ${m.property_id} AND status = 'sending'
          RETURNING id`);
        outcome = 'retried';
      }
      if (moved.rows.length === 0) return null;
      await tx.execute(sql`
        INSERT INTO outbox_attempt (property_id, message_id, at, ok, error)
        VALUES (${m.property_id}, ${m.id}, ${atSql}, ${failure === null}, ${failure?.message ?? null})`);
      return outcome;
    });
  }
}
