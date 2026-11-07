import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuditService } from '../common/audit.service';
import { CLOCK, type Clock } from '../common/clock';
import { asBody, validationFailed } from '../common/input';
import { PropertyContext } from '../common/property-context';
import { DB, type Db, type Tx } from '../db/tokens';
import type { Actor } from '../reservations/reservations.service';

// The property's operating settings (property_settings): when the night audit
// runs by itself, whether a no-show is charged, and the VAT rates the folio
// may use. Tax rates are never in code (spec 13.2): they come from here.
// GET without a row answers the defaults and writes nothing; PUT upserts.

export interface PropertySettings {
  /** 'HH:MM' in the property's timezone; null: no automatic night audit. */
  autoCloseTime: string | null;
  noShowCharge: 'none' | 'first_night';
  /** Basis points (1000 = 10 %); null: accommodation VAT not shown. */
  accommodationVatBp: number | null;
  /** The rates (basis points) a manual charge may carry, in the order set. */
  vatRatesBp: number[];
}

export const DEFAULT_SETTINGS: PropertySettings = {
  autoCloseTime: null,
  noShowCharge: 'none',
  accommodationVatBp: null,
  vatRatesBp: [],
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const NO_SHOW_CHARGES = ['none', 'first_night'] as const;
export const MAX_VAT_RATES = 5;

const isRate = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000;

/**
 * The fields present in a PUT body, checked: absent fields are left out (the
 * stored value stays), null clears autoCloseTime and accommodationVatBp.
 * noShowCharge and vatRatesBp cannot be null. Every failure is 422
 * validation_failed naming the field.
 */
export function parseSettingsInput(raw: unknown): Partial<PropertySettings> {
  const b = asBody(raw);
  const out: Partial<PropertySettings> = {};
  if (b.autoCloseTime !== undefined) {
    const v = b.autoCloseTime;
    if (v !== null && (typeof v !== 'string' || !TIME.test(v))) throw validationFailed('autoCloseTime');
    out.autoCloseTime = v as string | null;
  }
  if (b.noShowCharge !== undefined) {
    const v = b.noShowCharge;
    if (typeof v !== 'string' || !(NO_SHOW_CHARGES as readonly string[]).includes(v)) throw validationFailed('noShowCharge');
    out.noShowCharge = v as PropertySettings['noShowCharge'];
  }
  if (b.accommodationVatBp !== undefined) {
    const v = b.accommodationVatBp;
    if (v !== null && !isRate(v)) throw validationFailed('accommodationVatBp');
    out.accommodationVatBp = v as number | null;
  }
  if (b.vatRatesBp !== undefined) {
    const v = b.vatRatesBp;
    if (!Array.isArray(v) || v.length > MAX_VAT_RATES || !v.every(isRate) || new Set(v).size !== v.length) {
      throw validationFailed('vatRatesBp');
    }
    out.vatRatesBp = [...(v as number[])];
  }
  return out;
}

type SettingsRow = {
  auto_close_time: string | null;
  no_show_charge: PropertySettings['noShowCharge'];
  accommodation_vat_bp: number | null;
  vat_rates_bp: number[];
};

const SETTINGS_COLUMNS = sql`to_char(auto_close_time, 'HH24:MI') AS auto_close_time, no_show_charge,
  accommodation_vat_bp, array_to_json(vat_rates_bp) AS vat_rates_bp`;

function viewOf(r: SettingsRow): PropertySettings {
  return {
    autoCloseTime: r.auto_close_time,
    noShowCharge: r.no_show_charge,
    accommodationVatBp: r.accommodation_vat_bp,
    vatRatesBp: r.vat_rates_bp,
  };
}

@Injectable()
export class SettingsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly property: PropertyContext,
  ) {}

  async get(): Promise<PropertySettings> {
    const propertyId = await this.property.id();
    return this.read(this.db, propertyId);
  }

  /** The settings inside a caller's transaction (folio, night audit); defaults without a row, no write. */
  async read(q: Db | Tx, propertyId: string): Promise<PropertySettings> {
    const { rows } = await q.execute<SettingsRow>(
      sql`SELECT ${SETTINGS_COLUMNS} FROM property_settings WHERE property_id = ${propertyId}`,
    );
    return rows[0] ? viewOf(rows[0]) : { ...DEFAULT_SETTINGS, vatRatesBp: [] };
  }

  async update(raw: unknown, actor: Actor): Promise<PropertySettings> {
    const patch = parseSettingsInput(raw);
    const propertyId = await this.property.id();
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO property_settings (property_id) VALUES (${propertyId}) ON CONFLICT DO NOTHING`);
      const { rows } = await tx.execute<SettingsRow>(
        sql`SELECT ${SETTINGS_COLUMNS} FROM property_settings WHERE property_id = ${propertyId} FOR UPDATE`,
      );
      const before = viewOf(rows[0]);
      const after: PropertySettings = { ...before, ...patch };
      // Validated integers only, so the array literal cannot carry anything else.
      const rates = `{${after.vatRatesBp.join(',')}}`;
      await tx.execute(sql`
        UPDATE property_settings
           SET auto_close_time = ${after.autoCloseTime}::time,
               no_show_charge = ${after.noShowCharge},
               accommodation_vat_bp = ${after.accommodationVatBp}::int,
               vat_rates_bp = ${rates}::int[],
               updated_at = ${this.clock().toISOString()}::timestamptz
         WHERE property_id = ${propertyId}`);
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'settings.update',
        entity: 'property_settings',
        entityId: propertyId,
        before,
        after,
      });
      return after;
    });
  }
}
