/**
 * Loads 300k products into an in-process Postgres (PGlite) and prints query
 * plans + timings for the hot read paths, comparing keyset vs OFFSET paging.
 * Usage: npm run explain
 */
import { createTestDb } from '../test/pglite.js';
import { bulkInsertSql } from './bulk-sql.js';
import { ProductRepository } from '../src/products/repository.js';

const N = 300_000;
const db = await createTestDb();
let t = Date.now();
await db.exec(bulkInsertSql(N));
console.log(`loaded ${N} rows in ${Date.now() - t} ms\n`);

async function explain(label: string, sql: string, params: unknown[] = []) {
  const { rows } = await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS OFF, COSTS OFF) ${sql}`, params);
  console.log(`--- ${label}\n${rows.map((r) => r['QUERY PLAN']).join('\n')}\n`);
}

const cols = 'id, name, price_cents, created_at';
await explain(
  'category + price range, sorted by price, first page',
  `SELECT ${cols} FROM products WHERE deleted_at IS NULL AND category = 'category-7'
     AND price_cents BETWEEN 1000 AND 50000 ORDER BY price_cents, id LIMIT 21`,
);
await explain(
  'same filter, keyset page deep into the result (after price 45000)',
  `SELECT ${cols} FROM products WHERE deleted_at IS NULL AND category = 'category-7'
     AND price_cents BETWEEN 1000 AND 50000 AND (price_cents, id) > (45000, '00000000-0000-0000-0000-000000000000'::uuid)
     ORDER BY price_cents, id LIMIT 21`,
);
await explain(
  'same depth using OFFSET (what keyset avoids)',
  `SELECT ${cols} FROM products WHERE deleted_at IS NULL AND category = 'category-7'
     AND price_cents BETWEEN 1000 AND 50000 ORDER BY price_cents, id OFFSET 2700 LIMIT 21`,
);
await explain(
  'whole catalog, newest first, keyset page',
  `SELECT ${cols} FROM products WHERE deleted_at IS NULL
     AND (created_at, id) < (now() - interval '200 days', 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
     ORDER BY created_at DESC, id DESC LIMIT 21`,
);
await explain(
  'whole catalog, OFFSET 250000 (what keyset avoids)',
  `SELECT ${cols} FROM products WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC OFFSET 250000 LIMIT 21`,
);

// End-to-end through the repository: walk 50 pages deep and time each page.
const repo = new ProductRepository(db);
let cursor: string | undefined;
const times: number[] = [];
for (let i = 0; i < 50; i++) {
  t = performance.now();
  const page = await repo.list({ category: 'category-3', sort: 'price_desc', limit: 50, cursor });
  times.push(performance.now() - t);
  cursor = page.page.next_cursor ?? undefined;
}
console.log(
  `repository.list: page 1 ${times[0]!.toFixed(2)} ms, page 50 ${times[49]!.toFixed(2)} ms ` +
    `(median ${[...times].sort((a, b) => a - b)[25]!.toFixed(2)} ms)`,
);
await db.close();
