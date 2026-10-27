import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { AuthUser } from '../auth/sessions.service';
import { AuditService } from '../common/audit.service';
import { DomainError } from '../common/domain-error';
import {
  asBody,
  isUniqueViolation,
  isUuid,
  localized,
  optionalText,
  requireText,
  validationFailed,
  type Body,
} from '../common/input';
import { PropertyContext } from '../common/property-context';
import { unit, unitType, type LocalizedText } from '../db/schema';
import { DB, type Db, type Tx } from '../db/tokens';
import { InventoryService, scopeFor, scopeOrder, type Scope } from '../inventory/inventory.service';
import { LicenceService } from '../licensing/licence.service';

/**
 * Transaction-scoped advisory lock: every change to units and unit types is
 * serialised on it, so the rooms limit count and the "type still in use"
 * check see a settled set of units.
 */
export const UNITS_LOCK_KEY = 7_301_005;

export const MAX_CAPACITY = 50;

export interface UnitTypeView {
  id: string;
  code: string;
  name: LocalizedText;
  capacity: number;
  beds: string | null;
  description: Partial<LocalizedText> | null;
  active: boolean;
}

export interface UnitView {
  id: string;
  name: string;
  unitTypeId: string | null;
  address: string | null;
  municipality: string | null;
  eturistaObjectId: string | null;
  active: boolean;
  cleanliness: 'clean' | 'dirty' | 'inspected';
}

type UnitTypeRow = typeof unitType.$inferSelect;
type UnitRow = typeof unit.$inferSelect;

function typeView(r: UnitTypeRow): UnitTypeView {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    capacity: r.capacity,
    beds: r.beds,
    description: r.description ?? null,
    active: r.active,
  };
}

function unitView(r: UnitRow): UnitView {
  return {
    id: r.id,
    name: r.name,
    unitTypeId: r.unitTypeId,
    address: r.address,
    municipality: r.municipality,
    eturistaObjectId: r.eturistaObjectId,
    active: r.active,
    cleanliness: r.cleanliness,
  };
}

const unitTypeNotFound = () => new DomainError('unit_type_not_found', 'Tip jedinice ne postoji.', 404);
const unitNotFound = () => new DomainError('unit_not_found', 'Jedinica ne postoji.', 404);

function capacityOf(b: Body): number {
  const c = b.capacity;
  if (typeof c !== 'number' || !Number.isInteger(c) || c < 1 || c > MAX_CAPACITY) throw validationFailed('capacity');
  return c;
}

function activeOf(b: Body): boolean | undefined {
  if (b.active === undefined) return undefined;
  if (typeof b.active !== 'boolean') throw validationFailed('active');
  return b.active;
}

/** undefined (not sent), null (no type) or a type id. */
function unitTypeIdOf(b: Body): string | null | undefined {
  const v = b.unitTypeId;
  if (v === undefined || v === null) return v;
  if (typeof v !== 'string' || !isUuid(v)) throw validationFailed('unitTypeId');
  return v;
}

@Injectable()
export class UnitsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly property: PropertyContext,
    private readonly licence: LicenceService,
    private readonly inventory: InventoryService,
  ) {}

  // ---- unit types ----

  async listTypes(): Promise<UnitTypeView[]> {
    const propertyId = await this.property.id();
    const rows = await this.db.select().from(unitType).where(eq(unitType.propertyId, propertyId)).orderBy(asc(unitType.code));
    return rows.map(typeView);
  }

  async createType(actor: AuthUser, body: unknown): Promise<UnitTypeView> {
    const b = asBody(body);
    const code = requireText(b, 'code', 20);
    const name = localized(b.name, 'name', true);
    const capacity = capacityOf(b);
    const beds = optionalText(b, 'beds') ?? null;
    const description = b.description === undefined ? null : localized(b.description, 'description', false);
    const propertyId = await this.property.id();

    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(unitType)
          .values({ propertyId, code, name, capacity, beds, description })
          .returning();
        const view = typeView(row);
        await this.audit.record(tx, {
          propertyId,
          actorUserId: actor.id,
          action: 'unit_type.create',
          entity: 'unit_type',
          entityId: row.id,
          after: view,
        });
        return view;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw codeTaken();
      throw err;
    }
  }

  async updateType(actor: AuthUser, id: string, body: unknown): Promise<UnitTypeView> {
    if (!isUuid(id)) throw unitTypeNotFound();
    const b = asBody(body);
    const patch: Partial<typeof unitType.$inferInsert> = {};
    if (b.code !== undefined) patch.code = requireText(b, 'code', 20);
    if (b.name !== undefined) patch.name = localized(b.name, 'name', true);
    if (b.capacity !== undefined) patch.capacity = capacityOf(b);
    if (b.beds !== undefined) patch.beds = optionalText(b, 'beds') ?? null;
    if (b.description !== undefined) patch.description = localized(b.description, 'description', false);
    const active = activeOf(b);
    if (active !== undefined) patch.active = active;
    if (Object.keys(patch).length === 0) throw validationFailed('code', 'Nema izmena.');
    const propertyId = await this.property.id();

    try {
      return await this.db.transaction(async (tx) => {
        await this.lockUnits(tx);
        const [before] = await tx
          .select()
          .from(unitType)
          .where(and(eq(unitType.id, id), eq(unitType.propertyId, propertyId)))
          .for('update');
        if (!before) throw unitTypeNotFound();
        if (active === false && before.active) {
          const [{ n }] = await tx
            .select({ n: count() })
            .from(unit)
            .where(and(eq(unit.propertyId, propertyId), eq(unit.unitTypeId, id), eq(unit.active, true)));
          if (n > 0) {
            throw new DomainError('unit_type_in_use', 'Tip ima aktivne jedinice; prvo ih premestite ili isključite.', 409, {
              activeUnits: n,
            });
          }
        }
        const [row] = await tx
          .update(unitType)
          .set(patch)
          .where(and(eq(unitType.id, id), eq(unitType.propertyId, propertyId)))
          .returning();
        const view = typeView(row);
        await this.audit.record(tx, {
          propertyId,
          actorUserId: actor.id,
          action: 'unit_type.update',
          entity: 'unit_type',
          entityId: id,
          before: typeView(before),
          after: view,
        });
        return view;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw codeTaken();
      throw err;
    }
  }

  // ---- units ----

  async listUnits(): Promise<UnitView[]> {
    const propertyId = await this.property.id();
    const rows = await this.db.select().from(unit).where(eq(unit.propertyId, propertyId)).orderBy(asc(unit.name));
    return rows.map(unitView);
  }

  async createUnit(actor: AuthUser, body: unknown): Promise<UnitView> {
    const b = asBody(body);
    const name = requireText(b, 'name', 100);
    const unitTypeId = unitTypeIdOf(b) ?? null;
    const address = optionalText(b, 'address') ?? null;
    const municipality = optionalText(b, 'municipality') ?? null;
    const eturistaObjectId = optionalText(b, 'eturistaObjectId', 100) ?? null;
    const propertyId = await this.property.id();

    try {
      return await this.db.transaction(async (tx) => {
        await this.lockUnits(tx);
        if (unitTypeId) await this.assertUsableType(tx, propertyId, unitTypeId);
        await this.assertRoomForOneMore(tx, propertyId);
        const [row] = await tx
          .insert(unit)
          .values({ propertyId, name, unitTypeId, address, municipality, eturistaObjectId })
          .returning();
        await this.inventory.recomputeTotal(tx, propertyId, scopeFor(row.id, row.unitTypeId));
        const view = unitView(row);
        await this.audit.record(tx, {
          propertyId,
          actorUserId: actor.id,
          action: 'unit.create',
          entity: 'unit',
          entityId: row.id,
          after: view,
        });
        return view;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
  }

  /**
   * Name, address and the like change in place. A change of type or of
   * active also moves inventory: total is recomputed for the old and the new
   * scope in this transaction (409 inventory_conflict when a day no longer
   * fits); a unit with a block that is not over cannot make such a change.
   */
  async updateUnit(actor: AuthUser, id: string, body: unknown): Promise<UnitView> {
    if (!isUuid(id)) throw unitNotFound();
    const b = asBody(body);
    const patch: Partial<typeof unit.$inferInsert> = {};
    if (b.name !== undefined) patch.name = requireText(b, 'name', 100);
    const unitTypeId = unitTypeIdOf(b);
    if (unitTypeId !== undefined) patch.unitTypeId = unitTypeId;
    for (const [field, max] of [
      ['address', 200],
      ['municipality', 200],
      ['eturistaObjectId', 100],
    ] as const) {
      const v = optionalText(b, field, max);
      if (v !== undefined) patch[field] = v;
    }
    const active = activeOf(b);
    if (active !== undefined) patch.active = active;
    if (Object.keys(patch).length === 0) throw validationFailed('name', 'Nema izmena.');
    const propertyId = await this.property.id();

    try {
      return await this.db.transaction(async (tx) => {
        await this.lockUnits(tx);
        const [before] = await tx
          .select()
          .from(unit)
          .where(and(eq(unit.id, id), eq(unit.propertyId, propertyId)))
          .for('update');
        if (!before) throw unitNotFound();

        const nextTypeId = unitTypeId === undefined ? before.unitTypeId : unitTypeId;
        const nextActive = active ?? before.active;
        const typeChanged = nextTypeId !== before.unitTypeId;
        const activeChanged = nextActive !== before.active;
        if (typeChanged && nextTypeId) await this.assertUsableType(tx, propertyId, nextTypeId);
        if (nextActive && !before.active) await this.assertRoomForOneMore(tx, propertyId);
        if (typeChanged || activeChanged) await this.assertNoOpenBlocks(tx, propertyId, id);
        if (typeChanged || (activeChanged && !nextActive)) await this.assertNoOpenStays(tx, propertyId, id);

        const [row] = await tx
          .update(unit)
          .set(patch)
          .where(and(eq(unit.id, id), eq(unit.propertyId, propertyId)))
          .returning();

        if (typeChanged || activeChanged) {
          const scopes: Scope[] = [scopeFor(id, before.unitTypeId)];
          if (typeChanged) scopes.push(scopeFor(id, nextTypeId));
          for (const scope of scopes.sort(scopeOrder)) {
            await this.inventory.recomputeTotal(tx, propertyId, scope);
          }
        }

        const view = unitView(row);
        await this.audit.record(tx, {
          propertyId,
          actorUserId: actor.id,
          action: 'unit.update',
          entity: 'unit',
          entityId: id,
          before: unitView(before),
          after: view,
        });
        return view;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
  }

  private async lockUnits(tx: Tx): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${UNITS_LOCK_KEY})`);
  }

  private async assertUsableType(tx: Tx, propertyId: string, typeId: string): Promise<void> {
    const [t] = await tx
      .select({ active: unitType.active })
      .from(unitType)
      .where(and(eq(unitType.id, typeId), eq(unitType.propertyId, propertyId)));
    if (!t) throw unitTypeNotFound();
    if (!t.active) throw new DomainError('unit_type_inactive', 'Tip jedinice je isključen.', 409);
  }

  /** Licence limit `rooms` against the active units plus one. Call under the units lock. */
  private async assertRoomForOneMore(tx: Tx, propertyId: string): Promise<void> {
    const [{ n }] = await tx
      .select({ n: count() })
      .from(unit)
      .where(and(eq(unit.propertyId, propertyId), eq(unit.active, true)));
    this.licence.assertLimit('rooms', n + 1);
  }

  /**
   * A stay on the unit has its nights sold in the unit's current scope and
   * must stay on an active unit of its own type, so the unit can neither
   * change type (Ruling 15) nor be deactivated (Ruling 20) while a stay
   * assigned to it has not ended: otherwise the guest would sit on an
   * out-of-service unit and the type would count one unit too few. Call with
   * the unit row locked: book and assignUnit lock the same row.
   */
  private async assertNoOpenStays(tx: Tx, propertyId: string, unitId: string): Promise<void> {
    const today = await this.inventory.today(tx, propertyId);
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM stay
       WHERE property_id = ${propertyId} AND unit_id = ${unitId}
         AND status IN ('expected', 'in_house') AND departure > ${today}::date
       ORDER BY arrival LIMIT 1`);
    if (rows[0]) {
      throw new DomainError('unit_has_stays', 'Jedinica ima dodeljen boravak koji još traje; prvo ga premestite.', 409, {
        stayId: rows[0].id,
      });
    }
  }

  /**
   * A block holds blocked = 1 in the scope the unit had when it was made, so
   * the unit cannot leave that scope (type change, deactivation) while a block
   * still covers today or later. Call with the unit row locked.
   */
  private async assertNoOpenBlocks(tx: Tx, propertyId: string, unitId: string): Promise<void> {
    const today = await this.inventory.today(tx, propertyId);
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT id FROM unit_block
       WHERE property_id = ${propertyId} AND unit_id = ${unitId} AND upper(period) > ${today}::date
       ORDER BY lower(period) LIMIT 1`);
    if (rows[0]) {
      throw new DomainError('unit_has_blocks', 'Jedinica ima blokadu koja još traje; prvo je uklonite.', 409, {
        blockId: rows[0].id,
      });
    }
  }
}

function codeTaken(): DomainError {
  return new DomainError('unit_type_code_taken', 'Tip jedinice sa ovom oznakom već postoji.', 409);
}

function nameTaken(): DomainError {
  return new DomainError('unit_name_taken', 'Jedinica sa ovim nazivom već postoji.', 409);
}
