import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { AuditService } from '../common/audit.service';
import { CLOCK, type Clock } from '../common/clock';
import { DomainError } from '../common/domain-error';
import { asBody, requireEmail, requireOneOf, requireRawString, requireText } from '../common/input';
import { appUser, legalProfile, property, setupToken } from '../db/schema';
import { DB, type Db } from '../db/tokens';
import { ActivationService, ParentRefusedError } from '../licensing/activation.service';
import { LicenceService } from '../licensing/licence.service';
import { LicenceStore } from '../licensing/licence.store';
import { hashPassword } from './password';
import { newTotpSecret, totpUri, totpVerify } from './totp';

// 32 symbols without I, O, 0 and 1, so the code survives being read aloud or
// copied from a log; 32 divides 256, so `byte & 31` is unbiased. 12 symbols = 60 bits.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TOKEN_SYMBOLS = 12;

/** Transaction-scoped advisory lock serialising the owner and confirm steps. */
export const SETUP_LOCK_KEY = 7_301_003;

export const LEGAL_KINDS = ['legal_entity', 'entrepreneur', 'natural_person'] as const;

export interface SetupStatus {
  activated: boolean;
  /** The owner step ran; their TOTP waits for POST /setup/confirm. */
  hasOwner: boolean;
  hasProperty: boolean;
}

type Exec = Pick<Db, 'select' | 'execute'>;

function generateToken(): string {
  const bytes = randomBytes(TOKEN_SYMBOLS);
  let out = '';
  for (let i = 0; i < TOKEN_SYMBOLS; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += ALPHABET[bytes[i] & 31];
  }
  return out;
}

// Case and separators do not matter when the token is typed back.
function hashToken(token: string): Buffer {
  return createHash('sha256')
    .update(token.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .digest();
}

function setupDone(): DomainError {
  return new DomainError('setup_done', 'Prvo podešavanje je već završeno.', 410);
}

function tokenInvalid(): DomainError {
  return new DomainError('setup_token_invalid', 'Kod za prvo podešavanje nije ispravan.', 403);
}

/**
 * First-run setup, open until the owner has confirmed their TOTP. A random
 * setup token is written to the log at boot and kept only as a SHA-256 hash;
 * every setup call must present it.
 *
 *  1. POST /setup/activate: the Central Admin Panel code.
 *  2. POST /setup/owner: property, legal profile and owner, whose TOTP secret
 *     is in state 'setup' (cannot sign in). Repeating it replaces the secret
 *     (lost QR code) and the details; it never adds a second owner.
 *  3. POST /setup/confirm: the first code from the authenticator arms the
 *     secret and deletes the token. From then on every setup call is 410.
 *
 * "Open" is decided by the users table alone: setup is done as soon as any
 * user is not in TOTP state 'setup' (only the setup owner ever is).
 */
@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly activation: ActivationService,
    private readonly licence: LicenceService,
    private readonly store: LicenceStore,
  ) {}

  /**
   * Called by main.ts after migrations. While setup is open (also after a
   * restart between the owner step and confirmation), issues a new token,
   * replacing any earlier one so the owner is never locked out, logs it once
   * and returns it; otherwise returns null.
   */
  async prepareOnBoot(): Promise<string | null> {
    if (await this.isDone(this.db)) return null;
    const token = generateToken();
    await this.db
      .insert(setupToken)
      .values({ tokenHash: hashToken(token) })
      .onConflictDoUpdate({ target: setupToken.singleton, set: { tokenHash: hashToken(token), createdAt: sql`now()` } });
    this.logger.log(`[hotel-api] Kod za prvo podešavanje: ${token}`);
    return token;
  }

  async status(): Promise<SetupStatus> {
    await this.assertOpen(this.db);
    const [prop] = await this.db.select({ id: property.id }).from(property).limit(1);
    return {
      activated: (await this.store.get()) !== null,
      hasOwner: (await this.setupOwner(this.db)) !== undefined,
      hasProperty: prop !== undefined,
    };
  }

  /** Activates with a Central Admin Panel code; the licence applies at once. */
  async activate(body: unknown): Promise<void> {
    const b = asBody(body);
    await this.assertOpen(this.db);
    await this.assertToken(this.db, b.setupToken);
    const code = requireText(b, 'code');
    try {
      await this.activation.activate(code);
    } catch (err) {
      throw translateActivationError(err);
    }
    await this.licence.reload();
  }

  async createOwner(body: unknown): Promise<{ totpUri: string }> {
    const b = asBody(body);
    await this.assertOpen(this.db);
    await this.assertToken(this.db, b.setupToken);
    const propertyName = requireText(b, 'propertyName');
    const legalKind = requireOneOf(b, 'legalKind', LEGAL_KINDS);
    const email = requireEmail(b);
    const name = requireText(b, 'name');
    const passwordHash = await hashPassword(requireRawString(b, 'password'));
    const secret = newTotpSecret();

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);
      // Again under the lock: a concurrent step may have finished meanwhile.
      await this.assertOpen(tx);
      await this.assertToken(tx, b.setupToken);
      // Activation happens only through /setup/activate, which closes with
      // setup, so an owner on an unactivated installation could never activate.
      if ((await this.store.get(tx)) === null) {
        throw new DomainError('not_activated', 'Prvo aktivirajte instalaciju kodom iz Centralnog admina.', 409);
      }

      const [existing] = await tx.select({ id: property.id }).from(property).limit(1);
      const propertyId = existing
        ? (await tx.update(property).set({ name: propertyName }).returning({ id: property.id }))[0].id
        : (await tx.insert(property).values({ name: propertyName }).returning({ id: property.id }))[0].id;
      await tx
        .insert(legalProfile)
        .values({ propertyId, kind: legalKind })
        .onConflictDoUpdate({ target: legalProfile.propertyId, set: { kind: legalKind } });

      const fields = { email, name, passwordHash, totpSecret: secret, totpState: 'setup' as const, totpLastStep: null };
      const previous = await this.setupOwner(tx);
      const ownerId = previous
        ? (await tx.update(appUser).set(fields).where(eq(appUser.id, previous.id)).returning({ id: appUser.id }))[0].id
        : (
            await tx
              .insert(appUser)
              .values({ ...fields, propertyId, role: 'owner' })
              .returning({ id: appUser.id })
          )[0].id;

      await this.audit.record(tx, {
        propertyId,
        actorUserId: null,
        action: previous ? 'setup.owner_repeated' : 'setup.owner',
        entity: 'user',
        entityId: ownerId,
        after: { propertyName, legalKind, email, name, role: 'owner' },
      });
    });
    return { totpUri: totpUri(secret, email) };
  }

  /** The first code from the authenticator arms the owner's TOTP and closes setup. */
  async confirm(body: unknown): Promise<void> {
    const b = asBody(body);
    await this.assertOpen(this.db);
    await this.assertToken(this.db, b.setupToken);
    const code = typeof b.totp === 'string' ? b.totp.trim() : '';

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);
      await this.assertOpen(tx);
      await this.assertToken(tx, b.setupToken);
      const owner = await this.setupOwner(tx);
      if (!owner || !owner.totpSecret) {
        throw new DomainError('owner_missing', 'Prvo unesite podatke vlasnika.', 409);
      }
      const step = totpVerify(owner.totpSecret, code, this.clock(), owner.totpLastStep);
      if (step === null) {
        throw new DomainError('totp_invalid', 'Kod iz aplikacije za autentifikaciju nije ispravan.', 422);
      }
      await tx
        .update(appUser)
        .set({ totpState: 'confirmed', totpLastStep: step })
        .where(eq(appUser.id, owner.id));
      await tx.delete(setupToken);
      await this.audit.record(tx, {
        propertyId: owner.propertyId,
        actorUserId: owner.id,
        action: 'setup.complete',
        entity: 'user',
        entityId: owner.id,
        after: { totpState: 'confirmed' },
      });
    });
  }

  private async setupOwner(exec: Exec) {
    const [owner] = await exec
      .select()
      .from(appUser)
      .where(and(eq(appUser.role, 'owner'), eq(appUser.totpState, 'setup')))
      .limit(1);
    return owner;
  }

  private async isDone(exec: Exec): Promise<boolean> {
    const rows = await exec.select({ id: appUser.id }).from(appUser).where(ne(appUser.totpState, 'setup')).limit(1);
    return rows.length > 0;
  }

  private async assertOpen(exec: Exec): Promise<void> {
    if (await this.isDone(exec)) throw setupDone();
  }

  /** Constant-time comparison of SHA-256 digests; no token row means nothing matches. */
  private async assertToken(exec: Exec, given: unknown): Promise<void> {
    if (typeof given !== 'string' || given.length > 64) throw tokenInvalid();
    const [row] = await exec.select({ tokenHash: setupToken.tokenHash }).from(setupToken).limit(1);
    if (!row || row.tokenHash.length !== 32) throw tokenInvalid();
    if (!timingSafeEqual(hashToken(given), row.tokenHash)) throw tokenInvalid();
  }
}

/**
 * The Admin Panel's refusals belong to its namespace: a parent 401 or 429 must
 * not read as the hotel's own. Every one becomes 422 activation_refused with
 * the parent code in details. The hotel's own activation errors are plain
 * DomainErrors and pass unchanged.
 */
function translateActivationError(err: unknown): unknown {
  if (err instanceof ParentRefusedError) {
    return new DomainError('activation_refused', `Centralni admin je odbio aktivaciju: ${err.message}`, 422, {
      parentCode: err.code,
      parentStatus: err.status,
    });
  }
  return err;
}
