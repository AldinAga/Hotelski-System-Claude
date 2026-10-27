import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { AuditService } from '../common/audit.service';
import { createPool } from '../db/pool';
import * as schema from '../db/schema';
import type { Db } from '../db/tokens';
import { requiresTotp } from './sessions.service';
import { issuePendingTotp } from './totp-reset';

// Recovery when the last owner lost their authenticator (CLAUDE.md, "Oporavak
// TOTP-a"). Run inside the API container:
//   docker exec hotel-api-claude node dist/auth/reset-totp-cli.js --email <e>
// Prints a new otpauth URI; the user's sessions end and the first login with
// a code from the new secret arms it.

export async function resetTotpCli(
  argv: string[],
  db: Db,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const at = argv.indexOf('--email');
  const email = at >= 0 ? argv[at + 1]?.trim() : undefined;
  if (!email) {
    err('usage: reset-totp-cli --email <email>');
    return 2;
  }
  const [user] = await db.select().from(schema.appUser).where(eq(schema.appUser.email, email)).limit(1);
  if (!user) {
    err(`no user with email ${email}`);
    return 1;
  }
  if (!requiresTotp(user.role)) {
    err(`user ${email} has role ${user.role}, which signs in without TOTP`);
    return 1;
  }
  const uri = await db.transaction((tx) =>
    issuePendingTotp(tx, new AuditService(), { id: user.id, email: user.email, propertyId: user.propertyId }, null, 'cli'),
  );
  out(uri);
  return 0;
}

if (require.main === module) {
  const pool = createPool();
  resetTotpCli(process.argv.slice(2), drizzle(pool, { schema }), console.log, console.error)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => void pool.end());
}
