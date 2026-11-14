const int = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://catalog:catalog@localhost:5432/catalog',
  dbPoolSize: int(process.env.DB_POOL_SIZE, 20),
  cache: {
    itemTtlMs: int(process.env.CACHE_ITEM_TTL_MS, 60_000),
    listTtlMs: int(process.env.CACHE_LIST_TTL_MS, 10_000),
    maxItems: int(process.env.CACHE_MAX_ITEMS, 50_000),
    maxLists: int(process.env.CACHE_MAX_LISTS, 5_000),
  },
};
