import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, sql } from 'drizzle-orm';
import { AuditService } from '../common/audit.service';
import { DomainError } from '../common/domain-error';
import {
  asBody,
  isUniqueViolation,
  isUuid,
  requireEmail,
  requireOneOf,
  requireRawString,
  requireText,
  validationFailed,
} from '../common/input';
import { PropertyContext } from '../common/property-context';
import { appUser, USER_ROLES, userSession, type UserRole } from '../db/schema';
import { DB, type Db } from '../db/tokens';
import { LicenceService } from '../licensing/licence.service';
import { hashPassword } from './password';
import { requiresTotp, type AuthUser } from './sessions.service';
import { newTotpSecret, totpUri } from './totp';
import { issuePendingTotp } from './totp-reset';

/** Transaction-scoped advisory lock: every change to users is serialised on it. */
export const USERS_LOCK_KEY = 7_301_004;

export interface UserView {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  active: boolean;
  /** Only when this change gave the user a new TOTP secret (owner or manager). */
  totpUri?: string;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

function roleNotAllowed(): DomainError {
  return new DomainError('role_not_allowed', 'Samo vlasnik može da postavlja ili menja vlasnike.', 403);
}

function userNotFound(): DomainError {
  return new DomainError('user_not_found', 'Korisnik ne postoji.', 404);
}

function cannotModifySelf(): DomainError {
  return new DomainError('cannot_modify_self', 'Svoj nalog ne možete menjati ovde.', 409);
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly property: PropertyContext,
    private readonly licence: LicenceService,
  ) {}

  async create(actor: AuthUser, body: unknown): Promise<UserView> {
    const b = asBody(body);
    const email = requireEmail(b);
    const name = requireText(b, 'name');
    const role = requireOneOf(b, 'role', USER_ROLES);
    const password = requireRawString(b, 'password');
    if (role === 'owner' && actor.role !== 'owner') throw roleNotAllowed();
    const passwordHash = await hashPassword(password);
    // Armed by the user's first login with a code from it.
    const totpSecret = requiresTotp(role) ? newTotpSecret() : null;
    const propertyId = await this.property.id();

    try {
      return await this.db.transaction(async (tx) => {
        await this.lockAsActor(tx, actor);
        await this.assertRoomForOneMore(tx, propertyId);
        const [row] = await tx
          .insert(appUser)
          .values({
            propertyId,
            email,
            name,
            role,
            passwordHash,
            totpSecret,
            totpState: totpSecret ? 'pending' : 'none',
          })
          .returning();
        const view: UserView = { id: row.id, email: row.email, name: row.name, role: row.role, active: row.active };
        await this.audit.record(tx, {
          propertyId,
          actorUserId: actor.id,
          action: 'user.create',
          entity: 'user',
          entityId: row.id,
          after: view,
        });
        return totpSecret ? { ...view, totpUri: totpUri(totpSecret, row.email) } : view;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DomainError('email_taken', 'Korisnik sa ovom e-adresom već postoji.', 409);
      }
      throw err;
    }
  }

  /**
   * Changes role and/or active. Any role change or deactivation ends the
   * user's sessions, so rights a session never proved (a password-only
   * session promoted to manager) cannot carry over.
   */
  async update(actor: AuthUser, id: string, body: unknown): Promise<UserView> {
    if (!isUuid(id)) throw userNotFound();
    const b = asBody(body);
    const role = b.role === undefined ? undefined : requireOneOf(b, 'role', USER_ROLES);
    if (b.active !== undefined && typeof b.active !== 'boolean') throw validationFailed('active');
    const active = b.active as boolean | undefined;
    if (role === undefined && active === undefined) throw validationFailed('role', 'Navedite ulogu ili aktivnost.');
    // Keeps at least the acting owner: nobody can demote or lock out themselves.
    if (id === actor.id) throw cannotModifySelf();
    const propertyId = await this.property.id();

    return this.db.transaction(async (tx) => {
      await this.lockAsActor(tx, actor);
      const target = await this.lockTarget(tx, id, propertyId);
      if (actor.role !== 'owner' && (target.role === 'owner' || role === 'owner')) throw roleNotAllowed();

      const nextRole = role ?? target.role;
      const nextActive = active ?? target.active;
      if (nextActive && !target.active) await this.assertRoomForOneMore(tx, propertyId);

      // A role that needs TOTP gets a fresh pending secret unless one is armed already.
      const newSecret = requiresTotp(nextRole) && target.totpState !== 'confirmed' ? newTotpSecret() : null;
      const [row] = await tx
        .update(appUser)
        .set({
          role: nextRole,
          active: nextActive,
          ...(newSecret ? { totpSecret: newSecret, totpState: 'pending' as const, totpLastStep: null } : {}),
        })
        .where(eq(appUser.id, id))
        .returning();
      if (!nextActive || nextRole !== target.role) {
        await tx.delete(userSession).where(eq(userSession.userId, id));
      }

      await this.audit.record(tx, {
        propertyId,
        actorUserId: actor.id,
        action: 'user.update',
        entity: 'user',
        entityId: id,
        before: { role: target.role, active: target.active },
        after: { role: row.role, active: row.active },
      });
      const view: UserView = { id: row.id, email: row.email, name: row.name, role: row.role, active: row.active };
      return newSecret ? { ...view, totpUri: totpUri(newSecret, row.email) } : view;
    });
  }

  /**
   * A new pending TOTP secret for an owner or manager who lost theirs; their
   * sessions end. Owner only (the route says so). The last owner's own
   * recovery is the CLI, not this.
   */
  async resetTotp(actor: AuthUser, id: string): Promise<{ totpUri: string }> {
    if (!isUuid(id)) throw userNotFound();
    if (id === actor.id) throw cannotModifySelf();
    const propertyId = await this.property.id();
    return this.db.transaction(async (tx) => {
      await this.lockAsActor(tx, actor);
      const target = await this.lockTarget(tx, id, propertyId);
      if (!requiresTotp(target.role)) {
        throw new DomainError('totp_not_applicable', 'Ova uloga se prijavljuje bez koda za autentifikaciju.', 409);
      }
      const uri = await issuePendingTotp(tx, this.audit, target, actor.id, 'api');
      return { totpUri: uri };
    });
  }

  /**
   * Takes the users lock, then re-reads the actor: AuthGuard saw them before
   * the lock, and a concurrent change (two owners deactivating each other)
   * may have removed their rights since. Refuses unless they are still active
   * with the same role.
   */
  private async lockAsActor(tx: Tx, actor: AuthUser): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${USERS_LOCK_KEY})`);
    const [now] = await tx
      .select({ role: appUser.role, active: appUser.active })
      .from(appUser)
      .where(eq(appUser.id, actor.id));
    if (!now || !now.active || now.role !== actor.role) {
      throw new DomainError('actor_changed', 'Vaš nalog je u međuvremenu izmenjen. Prijavite se ponovo.', 409);
    }
  }

  private async lockTarget(tx: Tx, id: string, propertyId: string) {
    const [target] = await tx
      .select()
      .from(appUser)
      .where(and(eq(appUser.id, id), eq(appUser.propertyId, propertyId)))
      .for('update');
    if (!target) throw userNotFound();
    return target;
  }

  /** Licence limit `users` against the active users plus one. Call under the users lock. */
  private async assertRoomForOneMore(tx: Tx, propertyId: string): Promise<void> {
    const [{ n }] = await tx
      .select({ n: count() })
      .from(appUser)
      .where(and(eq(appUser.propertyId, propertyId), eq(appUser.active, true)));
    this.licence.assertLimit('users', n + 1);
  }
}
