// Usage: DATABASE_URL=postgres://... npm run seed -- 300000
import { config } from '../src/config.js';
import { createPgDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { bulkInsertSql } from './bulk-sql.js';

const n = Number(process.argv[2] ?? 300_000);
const db = createPgDb(config.databaseUrl);
await migrate(db);
const t = Date.now();
await db.exec(bulkInsertSql(n));
console.log(`seeded ${n} products in ${Date.now() - t} ms`);
await db.close();
