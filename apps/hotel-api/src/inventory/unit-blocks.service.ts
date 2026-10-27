import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AuthUser } from '../auth/sessions.service';
import { AuditService } from '../common/audit.service';
import { DomainError } from '../common/domain-error';
import {
  asBody,
  isExclusionViolation,
  isUuid,
  optionalText,
  requireDate,
  requireOneOf,
  validationFailed,
} from '../common/input';
import { PropertyContext } from '../common/property-context';
import { BLOCK_REASONS, type BlockReason } from '../db/schema';
import { DB, type Db, type Tx } from '../db/tokens';
import { InventoryService } from './inventory.service';

/** The longest block accepted, in nights. */
export const MAX_BLOCK_NIGHTS = 366;

export interface UnitBlockView {
  id: string;
  unitId: string;
  /** First blocked night (YYYY-MM-DD). */
  from: string;
  /** Exclusive: the first night that is free again. */
  to: string;
  reason: BlockReason;
  note: string | null;
}

type BlockRow = {
  id: string;
  unit_id: string;
  from: string;
  to: string;
  reason: BlockReason;
  note: string | null;
};

const unitNotFound = () => new DomainError('unit_not_found', 'Jedinica ne postoji.', 404);
const blockNotFound = () => new DomainError('block_not_found', 'Blokada ne postoji.', 404);

function view(r: BlockRow): UnitBlockView {
  return { id: r.id, unitId: r.unit_id, from: r.from, to: r.to, reason: r.reason, note: r.note };
}

function nights(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Blocks take a unit out of sale for [from, to). Each block holds blocked = 1
 * in the unit's inventory scope for each of its nights. The unit row is locked
 * first (SELECT ... FOR UPDATE), so a block and a change of the unit's type or
 * active flag never interleave.
 */
@Injectable()
export class UnitBlocksService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly property: PropertyContext,
    private readonly inventory: InventoryService,
  ) {}

  async create(actor: AuthUser, unitId: string, body: unknown): Promise<UnitBlockView> {
    if (!isUuid(unitId)) throw unitNotFound();
    const b = asBody(body);
    const from = requireDate(b, 'from');
    const to = requireDate(b, 'to');
    if (to <= from || nights(from, to) > MAX_BLOCK_NIGHTS) throw validationFailed('to');
    const reason = requireOneOf(b, 'reason', BLOCK_REASONS);
    const note = optionalText(b, 'note', 500) ?? null;
    const propertyId = await this.property.id();

    try {
      return await this.db.transaction(async (tx) => {
        const u = await this.lockUnit(tx, propertyId, unitId);
        if (!u.active) throw new DomainError('unit_inactive', 'Jedinica je isključena.', 409);
        // A block never reaches back before today: past nights may belong to
        // a scope the unit has since left.
        if (from < (await this.inventory.today(tx, propertyId))) {
          throw validationFailed('from', 'Blokada ne može da počne pre današnjeg dana.');
        }
        // A live stay on the unit in the period: book and assignUnit lock the
        // same unit row before checking blocks, so the two cannot pass each other.
        const { rows: stays } = await tx.execute<{ id: string }>(sql`
          SELECT id FROM stay
           WHERE property_id = ${propertyId} AND unit_id = ${unitId} AND status IN ('expected', 'in_house')
             AND daterange(arrival, departure, '[)') && daterange(${from}::date, ${to}::date, '[)')
           ORDER BY arrival LIMIT 1`);
        if (stays[0]) {
          throw new DomainError('unit_occupied', 'Jedinica je zauzeta boravkom u tom periodu.', 409, { stayId: stays[0].id });
        }
        // Inserted before taking inventory: an overlap with the unit's own
        // block is block_overlap, not no_availability.
        const { rows } = await tx.execute<BlockRow>(sql`
          INSERT INTO unit_block (property_id, unit_id, period, reason, note, created_by)
          VALUES (${propertyId}, ${unitId}, daterange(${from}::date, ${to}::date, '[)'), ${reason}, ${note}, ${actor.id})
          RETURNING id, unit_id, lower(period)::text AS "from", upper(period)::text AS "to", reason, note`);
        const scope = await this.inventory.scopeOfUnit(tx, propertyId, unitId);
        await this.inventory.take(tx, propertyId, scope, from, to, 'blocked', 1);
        const block = view(rows[0]);
        await this.audit.record(tx, {
          propertyId,
          actorUserId: actor.id,
          action: 'unit_block.create',
          entity: 'unit_block',
          entityId: block.id,
          after: block,
        });
        return block;
      });
    } catch (err) {
      if (isExclusionViolation(err)) {
        throw new DomainError('block_overlap', 'Jedinica je već blokirana u tom periodu.', 409);
      }
      throw err;
    }
  }

  async remove(actor: AuthUser, unitId: string, blockId: string): Promise<void> {
    if (!isUuid(unitId)) throw unitNotFound();
    if (!isUuid(blockId)) throw blockNotFound();
    const propertyId = await this.property.id();

    await this.db.transaction(async (tx) => {
      await this.lockUnit(tx, propertyId, unitId);
      const { rows } = await tx.execute<BlockRow>(sql`
        SELECT id, unit_id, lower(period)::text AS "from", upper(period)::text AS "to", reason, note
          FROM unit_block
         WHERE id = ${blockId} AND unit_id = ${unitId} AND property_id = ${propertyId}`);
      if (!rows[0]) throw blockNotFound();
      const block = view(rows[0]);
      // An ended block's nights may sit in a scope the unit has since left.
      const today = await this.inventory.today(tx, propertyId);
      if (block.to <= today) {
        throw new DomainError('block_ended', 'Blokada je završena i ne može se ukloniti.', 409);
      }
      await tx.execute(sql`DELETE FROM unit_block WHERE id = ${blockId} AND property_id = ${propertyId}`);
      const scope = await this.inventory.scopeOfUnit(tx, propertyId, unitId);
      // Only nights from today on are given back; the ledger before today is history.
      const releaseFrom = block.from < today ? today : block.from;
      await this.inventory.take(tx, propertyId, scope, releaseFrom, block.to, 'blocked', -1);
      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'unit_block.delete',
        entity: 'unit_block',
        entityId: blockId,
        before: block,
      });
    });
  }

  private async lockUnit(tx: Tx, propertyId: string, unitId: string): Promise<{ active: boolean }> {
    const { rows } = await tx.execute<{ active: boolean }>(
      sql`SELECT active FROM unit WHERE id = ${unitId} AND property_id = ${propertyId} FOR UPDATE`,
    );
    if (!rows[0]) throw unitNotFound();
    return rows[0];
  }
}
