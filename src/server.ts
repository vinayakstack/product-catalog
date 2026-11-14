import { buildApp } from './app.js';
import { config } from './config.js';
import { createPgDb, type Db } from './db/index.js';
import { migrate } from './db/migrate.js';

async function openDb(): Promise<Db> {
  if (config.databaseUrl.startsWith('pglite://')) {
    // Zero-dependency local mode: embedded Postgres, data lost on exit.
    const { createPgliteDb } = await import('./db/pglite.js');
    return createPgliteDb();
  }
  return createPgDb(config.databaseUrl, config.dbPoolSize);
}

const db = await openDb();
await migrate(db);

const app = buildApp({ db, cache: config.cache, logger: true });
await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close(); // stop accepting connections, drain in-flight requests
    await db.close();
    process.exit(0);
  });
}
