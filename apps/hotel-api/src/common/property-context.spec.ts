import { createTestDb, TestDb } from '../../test/db';
import { property } from '../db/schema';
import { DomainError } from './domain-error';
import { PropertyContext } from './property-context';

describe('PropertyContext', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb();
  });
  beforeEach(async () => {
    await t.truncate();
  });
  afterAll(async () => {
    await t.close();
  });

  it('throws property_missing (409) before the property is set up', async () => {
    const err = await new PropertyContext(t.db).id().catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: 'property_missing', status: 409 });
  });

  it('returns the single property id and caches it', async () => {
    const [row] = await t.db.insert(property).values({ name: 'Hotel' }).returning();
    const ctx = new PropertyContext(t.db);

    expect(await ctx.id()).toBe(row.id);
    await t.truncate();
    expect(await ctx.id()).toBe(row.id);
  });

  it('reset() forgets the cached id', async () => {
    const [first] = await t.db.insert(property).values({ name: 'Prvi' }).returning();
    const ctx = new PropertyContext(t.db);
    expect(await ctx.id()).toBe(first.id);

    await t.truncate();
    const [second] = await t.db.insert(property).values({ name: 'Drugi' }).returning();
    ctx.reset();
    expect(await ctx.id()).toBe(second.id);
  });

  it('the database refuses a second property (property_singleton)', async () => {
    await t.pool.query(`INSERT INTO property (name) VALUES ('Prvi')`);
    const err = await t.pool.query(`INSERT INTO property (name) VALUES ('Drugi')`).catch((e) => e);
    expect(err).toMatchObject({ code: '23505', constraint: 'property_singleton' });
  });
});
