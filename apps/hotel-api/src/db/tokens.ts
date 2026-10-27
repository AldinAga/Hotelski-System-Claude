import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema';

export const PG_POOL = Symbol('PG_POOL');
export const DB = Symbol('DB');
export type Db = NodePgDatabase<typeof schema>;
