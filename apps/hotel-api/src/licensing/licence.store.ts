import { Inject, Injectable } from '@nestjs/common';
import type { KeySet, LicenseEnvelope, SignedKeySet, VerifierMemory } from '@platform/licensing';
import { sql } from 'drizzle-orm';
import { DomainError } from '../common/domain-error';
import { installationLicence } from '../db/schema';
import { DB, type Db } from '../db/tokens';

export interface LicenceRecord {
  installationId: string;
  /** SecretBox-sealed base64url Ed25519 seed. */
  privateSeedEnc: string;
  envelope: LicenseEnvelope;
  /** The trusted key set the chain leads to (unsigned, as acceptKeySet returns it). */
  keySet: KeySet;
  /**
   * Every signed key set accepted after the pinned root, oldest first. This,
   * not keySet, is what a restart replays from HOTEL_ROOT_KEYSET: the database
   * is not a trust anchor.
   */
  keyChain: SignedKeySet[];
  memory: VerifierMemory;
  updatedAt: Date;
}

export type ActivationRecord = Omit<LicenceRecord, 'updatedAt'>;

// The database or a transaction opened from it.
export type StoreExecutor = Pick<Db, 'insert' | 'select'>;

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

// The single installation_licence row. Persistence only: what may be stored
// (verification, acceptance of key sets) is decided by the callers.
//
// Key sets are written only through saveActivation and saveKeyChain, which
// always write key_set and key_chain together so they cannot disagree.
@Injectable()
export class LicenceStore {
  constructor(@Inject(DB) private readonly db: Db) {}

  async get(exec: StoreExecutor = this.db): Promise<LicenceRecord | null> {
    const [row] = await exec.select().from(installationLicence).limit(1);
    if (!row) return null;
    return {
      installationId: row.installationId,
      privateSeedEnc: row.privateSeedEnc,
      envelope: row.envelope as LicenseEnvelope,
      keySet: row.keySet as KeySet,
      keyChain: row.keyChain as SignedKeySet[],
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
        keyChain: record.keyChain,
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

  /**
   * Replaces the signed chain and the trusted set it leads to, unless the
   * stored trusted set was issued later (a slower concurrent key sync must not
   * roll trust back). Equal issued_at is written (idempotent). Returns whether
   * the row was written.
   */
  async saveKeyChain(chain: SignedKeySet[], trusted: KeySet): Promise<boolean> {
    const rows = await this.db
      .update(installationLicence)
      .set({ keyChain: chain, keySet: trusted, updatedAt: sql`now()` })
      .where(sql`(${installationLicence.keySet} ->> 'issued_at')::timestamptz <= ${trusted.issued_at}::timestamptz`)
      .returning({ id: installationLicence.singleton });
    return rows.length > 0;
  }

  async saveMemory(memory: VerifierMemory): Promise<void> {
    await this.db.update(installationLicence).set({ memory, updatedAt: sql`now()` });
  }
}

export function alreadyActivated(): DomainError {
  return new DomainError('already_activated', 'Instalacija je već aktivirana.', 409);
}
