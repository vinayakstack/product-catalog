import pg from 'pg';

/**
 * Minimal database port. The app only needs parameterised queries, which lets
 * production use a real `pg` pool while tests use PGlite (real Postgres
 * compiled to WASM, in-process) with the exact same SQL.
 */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

// Return bigint columns (price_cents) as JS numbers. Safe: prices are far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export function createPgDb(connectionString: string, max = 20): Db {
  const pool = new pg.Pool({ connectionString, max });
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const res = await pool.query(text, params);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}
