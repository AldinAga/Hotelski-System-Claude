import { Inject, Injectable } from '@nestjs/common';
import type { KeySet, LicenseEnvelope, VerifierMemory } from '@platform/licensing';
import { sql } from 'drizzle-orm';
import { DomainError } from '../common/domain-error';
import { installationLicence } from '../db/schema';
import { DB, type Db } from '../db/tokens';

export interface LicenceRecord {
  installationId: string;
  /** SecretBox-sealed base64url Ed25519 seed. */
  privateSeedEnc: string;
  envelope: LicenseEnvelope;
  /** The trusted key set (accepted from the pinned root), not a signed one. */
  keySet: KeySet;
  memory: VerifierMemory;
  updatedAt: Date;
}

export type ActivationRecord = Omit<LicenceRecord, 'updatedAt'>;

// Anything with .insert: the database or a transaction opened from it.
export type StoreExecutor = Pick<Db, 'insert'>;

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

// The single installation_licence row. Persistence only: what may be stored
// (verification, ordering of key sets) is decided by the callers.
@Injectable()
export class LicenceStore {
  constructor(@Inject(DB) private readonly db: Db) {}

  async get(): Promise<LicenceRecord | null> {
    const [row] = await this.db.select().from(installationLicence).limit(1);
    if (!row) return null;
    return {
      installationId: row.installationId,
      privateSeedEnc: row.privateSeedEnc,
      envelope: row.envelope as LicenseEnvelope,
      keySet: row.keySet as KeySet,
      memory: row.memory as VerifierMemory,
      updatedAt: row.updatedAt,
    };
  }

  /** Inserts the row; a row already there is 409 already_activated. */
  async saveActivation(record: ActivationRecord, exec: StoreExecutor = this.db): Promise<void> {
    try {
      await exec.insert(installationLicence).values({
        installationId: record.installationId,
        privateSeedEnc: record.privateSeedEnc,
        envelope: record.envelope,
        keySet: record.keySet,
        memory: record.memory,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw alreadyActivated();
      throw err;
    }
  }

  /**
   * Replaces licence and memory together, unless the stored licence has a
   * higher revision (a slower concurrent refresh must not roll it back).
   * Returns whether the row was written.
   */
  async saveLicence(envelope: LicenseEnvelope, memory: VerifierMemory): Promise<boolean> {
    const rows = await this.db
      .update(installationLicence)
      .set({ envelope, memory, updatedAt: sql`now()` })
      .where(sql`(${installationLicence.envelope} -> 'payload' ->> 'revision')::bigint <= ${envelope.payload.revision}`)
      .returning({ id: installationLicence.singleton });
    return rows.length > 0;
  }

  async saveKeySet(keySet: KeySet): Promise<void> {
    await this.db.update(installationLicence).set({ keySet, updatedAt: sql`now()` });
  }

  async saveMemory(memory: VerifierMemory): Promise<void> {
    await this.db.update(installationLicence).set({ memory, updatedAt: sql`now()` });
  }
}

export function alreadyActivated(): DomainError {
  return new DomainError('already_activated', 'Instalacija je već aktivirana.', 409);
}
