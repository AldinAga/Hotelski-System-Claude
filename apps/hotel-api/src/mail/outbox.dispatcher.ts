import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../common/clock';
import { DB, type Db } from '../db/tokens';
import { MAIL_FROM, MAIL_TRANSPORT, MailError, type MailTransport } from './mail-transport';
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
      result[outcome] += 1;
    }
    return result;
  }

  private async claim(limit: number): Promise<Claimed[]> {
    const now = this.clock();
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.execute<Claimed>(sql`
        SELECT id, property_id, template, recipient, payload, attempts
          FROM outbox_message
         WHERE (status = 'pending' OR (status = 'sending' AND lease_until < ${now.toISOString()}::timestamptz))
           AND next_attempt_at <= ${now.toISOString()}::timestamptz
         ORDER BY next_attempt_at, id
           FOR UPDATE SKIP LOCKED
         LIMIT ${limit}`);
      for (const m of rows) {
        await tx.execute(sql`
          UPDATE outbox_message
             SET status = 'sending', lease_until = ${addMinutes(now, LEASE_MINUTES).toISOString()}::timestamptz
           WHERE id = ${m.id} AND property_id = ${m.property_id}`);
      }
      return rows;
    });
  }

  private async deliver(m: Claimed): Promise<keyof DispatchResult> {
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
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO outbox_attempt (property_id, message_id, at, ok, error)
        VALUES (${m.property_id}, ${m.id}, ${atSql}, ${failure === null}, ${failure?.message ?? null})`);
      if (failure === null) {
        await tx.execute(sql`
          UPDATE outbox_message SET status = 'sent', attempts = ${attempts}, sent_at = ${atSql}, lease_until = NULL, last_error = NULL
           WHERE id = ${m.id} AND property_id = ${m.property_id}`);
        return 'sent';
      }
      if (failure.permanent || attempts > BACKOFF_MINUTES.length) {
        await tx.execute(sql`
          UPDATE outbox_message SET status = 'failed', attempts = ${attempts}, lease_until = NULL, last_error = ${failure.message}
           WHERE id = ${m.id} AND property_id = ${m.property_id}`);
        return 'failed';
      }
      await tx.execute(sql`
        UPDATE outbox_message
           SET status = 'pending', attempts = ${attempts}, lease_until = NULL, last_error = ${failure.message},
               next_attempt_at = ${addMinutes(at, BACKOFF_MINUTES[attempts - 1]).toISOString()}::timestamptz
         WHERE id = ${m.id} AND property_id = ${m.property_id}`);
      return 'retried';
    });
  }
}
