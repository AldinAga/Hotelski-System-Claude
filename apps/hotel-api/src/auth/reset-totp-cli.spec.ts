import { seedUser } from '../../test/auth-helpers';
import { createTestDb, TestDb } from '../../test/db';
import { resetTotpCli } from './reset-totp-cli';

describe('reset-totp CLI (last-owner recovery)', () => {
  let t: TestDb;
  let out: string[];
  let err: string[];
  const run = (argv: string[]) =>
    resetTotpCli(
      argv,
      t.db,
      (l) => out.push(l),
      (l) => err.push(l),
    );

  beforeAll(async () => {
    t = await createTestDb();
  });
  beforeEach(async () => {
    await t.truncate();
    out = [];
    err = [];
  });
  afterAll(async () => {
    await t.close();
  });

  it('prints a new otpauth URI, makes the secret pending and ends the sessions', async () => {
    const owner = await seedUser(t, 'owner');
    await t.pool.query(
      `INSERT INTO user_session (user_id, token_hash, expires_at, absolute_expires_at)
       VALUES ($1, '\\x00', now() + interval '1 hour', now() + interval '1 day')`,
      [owner.id],
    );

    expect(await run(['--email', owner.email.toUpperCase()])).toBe(0);
    expect(out).toHaveLength(1);
    const uri = new URL(out[0]);
    expect(out[0].startsWith('otpauth://totp/Hotel:')).toBe(true);
    const secret = uri.searchParams.get('secret')!;
    expect(secret).not.toBe(owner.totpSecret);

    const { rows } = await t.pool.query('SELECT totp_secret, totp_state, totp_last_step FROM app_user');
    expect(rows).toEqual([{ totp_secret: secret, totp_state: 'pending', totp_last_step: null }]);
    expect((await t.pool.query('SELECT 1 FROM user_session')).rows).toHaveLength(0);
    const audit = await t.pool.query(`SELECT actor_user_id, after FROM audit_log WHERE action = 'user.totp_reset'`);
    expect(audit.rows).toEqual([{ actor_user_id: null, after: { totpState: 'pending', via: 'cli' } }]);
  });

  it('refuses a missing argument, an unknown email and a role without TOTP', async () => {
    expect(await run([])).toBe(2);
    expect(await run(['--email', 'niko@hotel.test'])).toBe(1);
    const rec = await seedUser(t, 'receptionist');
    expect(await run(['--email', rec.email])).toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(3);
  });
});
