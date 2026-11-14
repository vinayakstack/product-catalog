import type { Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { createPgliteDb } from '../src/db/pglite.js';

export async function createTestDb(): Promise<Db> {
  const db = await createPgliteDb();
  await migrate(db);
  return db;
}
