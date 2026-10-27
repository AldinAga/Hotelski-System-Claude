import { eq } from 'drizzle-orm';
import type { AuditService } from '../common/audit.service';
import { appUser, userSession } from '../db/schema';
import type { Db } from '../db/tokens';
import { newTotpSecret, totpUri } from './totp';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface TotpResetTarget {
  id: string;
  email: string;
  propertyId: string;
}

/**
 * Gives the user a fresh TOTP secret in state 'pending' (armed by their first
 * login with a code from it), forgets the last used step, ends every session
 * of the user and records it. Returns the enrolment URI. Shared by
 * POST /users/:id/reset-totp and the recovery CLI; runs in the caller's
 * transaction.
 */
export async function issuePendingTotp(
  tx: Tx,
  audit: AuditService,
  target: TotpResetTarget,
  actorUserId: string | null,
  via: 'api' | 'cli',
): Promise<string> {
  const secret = newTotpSecret();
  await tx
    .update(appUser)
    .set({ totpSecret: secret, totpState: 'pending', totpLastStep: null })
    .where(eq(appUser.id, target.id));
  await tx.delete(userSession).where(eq(userSession.userId, target.id));
  await audit.record(tx, {
    propertyId: target.propertyId,
    actorUserId,
    action: 'user.totp_reset',
    entity: 'user',
    entityId: target.id,
    after: { totpState: 'pending', via },
  });
  return totpUri(secret, target.email);
}
