import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { AuditService } from '../common/audit.service';
import { CLOCK, type Clock } from '../common/clock';
import { DomainError } from '../common/domain-error';
import { EMAIL_MAX } from '../common/input';
import { appUser, loginAttempt, userSession, type UserRole } from '../db/schema';
import { DB, type Db } from '../db/tokens';
import { DUMMY_PASSWORD_HASH, PASSWORD_MAX_LENGTH, verifyPassword } from './password';
import { totpVerify } from './totp';

export const SESSION_COOKIE = 'hotel_session';
/** Idle lifetime: moved forward by use, never past the absolute deadline. */
export const SESSION_IDLE_MS = 12 * 60 * 60_000;
/** Hard ceiling from login; use never extends it. */
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60_000;
export const LOGIN_WINDOW_MS = 15 * 60_000;
/** Attempts per email inside the window that may proceed; the next one is 429. */
export const LOGIN_MAX_FAILURES = 5;
// The idle deadline is written only when it would move by more than this,
// so a burst of requests does not write the session row each time.
const RENEW_GRANULARITY_MS = 60_000;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Roles that sign in only with a TOTP code. */
export function requiresTotp(role: UserRole): boolean {
  return role === 'owner' || role === 'manager';
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

/** The signed-in user of a request, as AuthGuard attaches it. */
export interface AuthUser extends PublicUser {
  propertyId: string;
  sessionId: string;
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
}

const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

function invalidCredentials(): DomainError {
  // One answer for a wrong or unknown email, a wrong password and an inactive
  // user, so the response does not tell which it was.
  return new DomainError('invalid_credentials', 'Neispravni pristupni podaci.', 401);
}

function totpRequired(): DomainError {
  return new DomainError('totp_required', 'Potreban je važeći kod iz aplikacije za autentifikaciju.', 401);
}

@Injectable()
export class SessionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /**
   * Password, then TOTP for owner and manager. Every attempt is first counted
   * for its email (in the database, so a restart does not reset it); more than
   * LOGIN_MAX_FAILURES attempts inside LOGIN_WINDOW_MS are refused with 429
   * before the password is looked at. A success clears its email's count only.
   */
  async login(email: unknown, password: unknown, totp: unknown): Promise<IssuedSession & { user: PublicUser }> {
    const emailText = typeof email === 'string' ? email.trim() : '';
    const passwordText = typeof password === 'string' && password.length <= PASSWORD_MAX_LENGTH ? password : '';
    const totpText = typeof totp === 'string' ? totp.trim() : '';
    const now = this.clock();

    if (emailText === '' || emailText.length > EMAIL_MAX) {
      await verifyPassword(passwordText, DUMMY_PASSWORD_HASH);
      throw invalidCredentials();
    }
    await this.countAttempt(emailText, now);

    const [user] = await this.db.select().from(appUser).where(eq(appUser.email, emailText)).limit(1);
    // Always one scrypt run, also for an unknown email, so timing does not
    // reveal which emails exist.
    const passwordOk = await verifyPassword(passwordText, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !user.active || !passwordOk) throw invalidCredentials();

    if (requiresTotp(user.role)) {
      // Fails closed: an owner or manager needs a secret that is armed
      // ('confirmed') or waiting for its first code ('pending'). A secret from
      // the first-run owner step is armed only by POST /setup/confirm.
      if (!user.totpSecret || (user.totpState !== 'pending' && user.totpState !== 'confirmed')) {
        throw new DomainError(
          'totp_not_enrolled',
          'Aplikacija za autentifikaciju još nije potvrđena za ovaj nalog. Obratite se vlasniku.',
          401,
        );
      }
      const step = totpVerify(user.totpSecret, totpText, now, user.totpLastStep);
      // Claimed only after the password passed, so a wrong password cannot
      // burn the real user's current code.
      if (step === null || !(await this.consumeTotpStep(user.id, user.totpSecret, step))) throw totpRequired();
    }

    return this.db.transaction(async (tx) => {
      await tx.delete(loginAttempt).where(eq(loginAttempt.email, emailText));
      const issued = await this.issue(tx, user.id, now);
      await this.audit.record(tx, {
        propertyId: user.propertyId,
        actorUserId: user.id,
        action: 'user.login',
        entity: 'user',
        entityId: user.id,
        after: { role: user.role },
      });
      return { ...issued, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
    });
  }

  /** A new session for `userId` (login uses it; tests sign users in with it). */
  async create(userId: string): Promise<IssuedSession> {
    return this.issue(this.db, userId, this.clock());
  }

  /**
   * The user behind a session token, or null when the token is malformed,
   * unknown, idle for SESSION_IDLE_MS, past its absolute deadline, or its user
   * is inactive. A valid use moves the idle deadline forward.
   */
  async authenticate(token: string): Promise<AuthUser | null> {
    if (!TOKEN.test(token)) return null;
    const now = this.clock();
    const [row] = await this.db
      .select({
        sessionId: userSession.id,
        expiresAt: userSession.expiresAt,
        absoluteExpiresAt: userSession.absoluteExpiresAt,
        id: appUser.id,
        email: appUser.email,
        name: appUser.name,
        role: appUser.role,
        propertyId: appUser.propertyId,
      })
      .from(userSession)
      .innerJoin(appUser, eq(appUser.id, userSession.userId))
      .where(
        and(
          eq(userSession.tokenHash, hashToken(token)),
          gt(userSession.expiresAt, now),
          gt(userSession.absoluteExpiresAt, now),
          eq(appUser.active, true),
        ),
      )
      .limit(1);
    if (!row) return null;

    const renewed = new Date(Math.min(now.getTime() + SESSION_IDLE_MS, row.absoluteExpiresAt.getTime()));
    if (renewed.getTime() - row.expiresAt.getTime() > RENEW_GRANULARITY_MS) {
      await this.db.update(userSession).set({ expiresAt: renewed }).where(eq(userSession.id, row.sessionId));
    }
    const { sessionId, id, email, name, role, propertyId } = row;
    return { sessionId, id, email, name, role, propertyId };
  }

  async logout(user: AuthUser): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(userSession).where(eq(userSession.id, user.sessionId));
      await this.audit.record(tx, {
        propertyId: user.propertyId,
        actorUserId: user.id,
        action: 'user.logout',
        entity: 'user',
        entityId: user.id,
      });
    });
  }

  /**
   * Replay guard: the UPDATE is the check. It succeeds only when `step` is
   * newer than the stored last step, so of two concurrent logins with one
   * code only one gets a row back. A 'pending' secret is armed by the same
   * write: the code proved the user holds it.
   */
  private async consumeTotpStep(userId: string, secret: string, step: number): Promise<boolean> {
    const rows = await this.db
      .update(appUser)
      .set({ totpLastStep: step, totpState: 'confirmed' })
      .where(
        and(
          eq(appUser.id, userId),
          // The secret the code was checked against: a reset in between must not be armed by it.
          eq(appUser.totpSecret, secret),
          or(isNull(appUser.totpLastStep), lt(appUser.totpLastStep, step)),
        ),
      )
      .returning({ id: appUser.id });
    return rows.length === 1;
  }

  /**
   * Records the attempt first, then counts: concurrent attempts each see the
   * others, so no burst gets more than LOGIN_MAX_FAILURES through. A refused
   * attempt counts too, which keeps the lock while someone keeps trying.
   */
  private async countAttempt(email: string, now: Date): Promise<void> {
    const windowStart = new Date(now.getTime() - LOGIN_WINDOW_MS);
    await this.db.insert(loginAttempt).values({ email, at: now });
    await this.db.delete(loginAttempt).where(lt(loginAttempt.at, windowStart));
    const [{ n }] = await this.db
      .select({ n: count() })
      .from(loginAttempt)
      .where(and(eq(loginAttempt.email, email), gt(loginAttempt.at, windowStart)));
    if (n > LOGIN_MAX_FAILURES) {
      throw new DomainError(
        'too_many_attempts',
        'Previše neuspešnih pokušaja prijave. Pokušajte ponovo za 15 minuta.',
        429,
      );
    }
  }

  private async issue(exec: Pick<Db, 'insert'>, userId: string, now: Date): Promise<IssuedSession> {
    const token = randomBytes(32).toString('base64url');
    const absoluteExpiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
    const expiresAt = new Date(now.getTime() + SESSION_IDLE_MS);
    await exec.insert(userSession).values({ userId, tokenHash: hashToken(token), expiresAt, absoluteExpiresAt });
    return { token, expiresAt, absoluteExpiresAt };
  }
}
