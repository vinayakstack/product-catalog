import { PGlite } from '@electric-sql/pglite';
import type { Db } from './index.js';

/**
 * Real Postgres compiled to WASM, running in-process. Used by the test suite
 * and by `DATABASE_URL=pglite://memory` for trying the API without Docker.
 * Not intended for production (single connection, in-memory).
 */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const pg = await PGlite.create(dataDir);
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const res = await pg.query<T>(text, params);
      return { rows: res.rows };
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    close: () => pg.close(),
  };
}
