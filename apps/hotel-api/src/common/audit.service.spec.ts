import { createTestDb, TestDb } from '../../test/db';
import { auditLog } from '../db/schema';
import { AuditService } from './audit.service';

describe('AuditService', () => {
  let t: TestDb;
  const audit = new AuditService();
  const entry = {
    propertyId: null,
    actorUserId: null,
    action: 'create',
    entity: 'thing',
    entityId: '42',
    before: null,
    after: { a: 1 },
  };

  beforeAll(async () => {
    t = await createTestDb();
  });
  beforeEach(async () => {
    await t.truncate();
  });
  afterAll(async () => {
    await t.close();
  });

  it('writes the row in the caller transaction and keeps it on commit', async () => {
    await t.db.transaction((tx) => audit.record(tx, entry));

    const rows = await t.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'create', entity: 'thing', entityId: '42', after: { a: 1 } });
  });

  it('loses the row when the transaction is rolled back', async () => {
    await expect(
      t.db.transaction(async (tx) => {
        await audit.record(tx, entry);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('truncate() empties audit_log and restarts its identity', async () => {
    await t.db.transaction((tx) => audit.record(tx, entry));
    await t.truncate();
    await t.db.transaction((tx) => audit.record(tx, entry));

    const rows = await t.db.select().from(auditLog);
    expect(rows.map((r) => r.id)).toEqual([1]);
  });
});
