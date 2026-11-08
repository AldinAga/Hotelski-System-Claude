import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { createAccessResolver } from '@platform/licensing';
import { sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../common/clock';
import { DomainError } from '../common/domain-error';
import { PropertyContext } from '../common/property-context';
import { DB, type Db } from '../db/tokens';
import { localDate } from '../inventory/inventory.service';
import { LicenceService } from '../licensing/licence.service';
import { SAFE_MODE_ALLOWED } from '../licensing/safe-mode';
import { addDays, NightAuditService } from './night-audit.service';
import { SettingsService } from './settings.service';

// The automatic night audit (spec 5.6): with auto_close_time set, the open day
// D is closed once the property's local time reaches auto_close_time on D + 1.
// It runs inside hotel-api (preflight F23b); only main.ts starts it, after the
// migrations and LicenceService.start(); tests call runOnce().
//
// A refusal (a DomainError: a guest due to leave still in house, a night that
// cannot be posted) is stored on the open day as last_auto_error, in its own
// transaction, and the front desk sees it on GET /business-day.
//
// It obeys the licence like the route it stands in for (hotel.folio,
// business_day.close, allowed in safe mode): a licence that would refuse the
// manual close turns the automatic one off.

export type AutoCloseResult = 'closed' | 'not_due' | 'blocked' | 'disabled';

const TICK_MS = 60_000;

/** 'YYYY-MM-DD HH:MM' of `at` in `timezone` (24-hour clock). */
export function localDateTime(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${localDate(at, timezone)} ${part('hour')}:${part('minute')}`;
}

@Injectable()
export class NightAuditScheduler implements OnModuleDestroy {
  private readonly log = new Logger('NightAuditScheduler');
  private readonly resolve = createAccessResolver({ safeModeAllowed: SAFE_MODE_ALLOWED });
  private timer: NodeJS.Timeout | null = null;
  /** The run in flight: an overlapping call joins it instead of running beside it. */
  private running: Promise<AutoCloseResult> | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly property: PropertyContext,
    private readonly settings: SettingsService,
    private readonly audit: NightAuditService,
    private readonly licence: LicenceService,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce().catch((err: unknown) => this.log.error(`automatic close failed: ${String(err)}`));
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

  runOnce(): Promise<AutoCloseResult> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async run(): Promise<AutoCloseResult> {
    const evaluation = this.licence.evaluation();
    if (!evaluation || !this.resolve(evaluation, { module: 'hotel.folio', action: 'business_day.close' }).allowed) {
      return 'disabled';
    }
    let propertyId: string;
    try {
      propertyId = await this.property.id();
    } catch (err) {
      if (err instanceof DomainError) return 'disabled'; // property_missing: setup not finished
      throw err;
    }
    const { autoCloseTime } = await this.settings.read(this.db, propertyId);
    if (autoCloseTime === null) return 'disabled';

    const now = this.clock();
    const { rows } = await this.db.execute<{ timezone: string; day: string | null }>(sql`
      SELECT p.timezone,
             (SELECT day::text FROM business_day WHERE property_id = p.id AND status = 'open') AS day
        FROM property p WHERE p.id = ${propertyId}`);
    const { timezone } = rows[0];
    // Without an open row the day is today, never due before tomorrow; nothing is written.
    const day = rows[0].day ?? localDate(now, timezone);
    if (localDateTime(now, timezone) < `${addDays(day, 1)} ${autoCloseTime}`) return 'not_due';

    try {
      await this.audit.close(day, null, 'auto');
      return 'closed';
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      const error = { at: now.toISOString(), code: err.code, details: err.details ?? null };
      await this.db.execute(sql`
        UPDATE business_day SET last_auto_error = ${JSON.stringify(error)}::jsonb
         WHERE property_id = ${propertyId} AND status = 'open'`);
      return 'blocked';
    }
  }
}
