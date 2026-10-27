import { Injectable } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema';

// Anything with .insert: the Drizzle database or a transaction opened from it.
export type AuditExecutor = Pick<NodePgDatabase<typeof schema>, 'insert'>;

export interface AuditEntry {
  propertyId: string | null;
  actorUserId: string | null;
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

@Injectable()
export class AuditService {
  // Always called with the caller's transaction so the audit row commits or
  // rolls back together with the change it describes.
  async record(tx: AuditExecutor, e: AuditEntry): Promise<void> {
    await tx.insert(schema.auditLog).values({
      propertyId: e.propertyId,
      actorUserId: e.actorUserId,
      action: e.action,
      entity: e.entity,
      entityId: e.entityId,
      before: e.before ?? null,
      after: e.after ?? null,
    });
  }
}
