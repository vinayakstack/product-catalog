# Product Catalog API

A read-optimized REST backend for an e-commerce product catalog: CRUD on products, plus filtered, sorted,
paginated listing. TypeScript · Fastify · PostgreSQL.

```bash
npm install
npm test                                        # 19 integration tests against real Postgres (in-process, no Docker)
DATABASE_URL=pglite://memory npm start          # run the API with an embedded Postgres, no Docker
docker compose up --build                       # or: API + Postgres 17
DATABASE_URL=postgres://catalog:catalog@localhost:5432/catalog npm run seed -- 300000
npm run explain                                 # load 300k rows, print query plans + timings
```

## API

| Method | Path | Notes |
|---|---|---|
| `POST` | `/products` | `201` + `Location` + `ETag`. `409` if the SKU is taken. |
| `GET` | `/products/:id` | `ETag` / `If-None-Match` → `304`. `Cache-Control: public, max-age=30`. |
| `GET` | `/products` | `category`, `min_price`, `max_price` (cents, inclusive), `sort` = `newest` \| `price_asc` \| `price_desc`, `limit` (1–100, default 20), `cursor`. |
| `PATCH` | `/products/:id` | Partial update. Optional `If-Match: "<version>"` → `412` on a stale write. |
| `DELETE` | `/products/:id` | Soft delete, `204`. Optional `If-Match`. |
| `GET` | `/healthz` | Checks DB connectivity. |

```jsonc
// POST /products
{ "sku": "TSHIRT-001", "name": "Classic Tee", "category": "apparel", "price_cents": 1999,
  "currency": "USD", "stock": 40, "attributes": { "size": "M", "color": "navy" } }

// GET /products?category=apparel&min_price=1000&max_price=5000&sort=price_asc&limit=20
{ "data": [ { "id": "01a1d821-…", "sku": "TSHIRT-001", "price_cents": 1999, "version": 1, … } ],
  "page": { "limit": 20, "next_cursor": "WyJwcmljZV9hc2MiLDE5OTksIjAxYTFkODIxLi4uIl0" } }
```

Errors share one shape: `{ "error": { "code": "validation_error" | "not_found" | "conflict" | "precondition_failed" | …, "message", "details" } }`.

## Design and reasoning

### The workload
A few hundred thousand products, reads far outnumbering writes, and listing by category and price range with
pagination. I optimized for fast, predictable list queries, then added caching on top. Writes stay simple and correct.

### Datastore: PostgreSQL
- **Size.** 300k products is roughly 300 MB with indexes, which fits in RAM on a small instance. Sharding or a distributed
  store would add operational cost and no benefit.
- **Query shape.** Equality on category plus a range on price, sorted, is exactly what a composite B-tree index does well.
  A key-value store can't range-scan secondary attributes, and a document store would need the same indexes anyway.
- **Correctness.** Unique SKUs, `CHECK` constraints on price and stock, and atomic conditional updates for optimistic
  locking all come for free.
- **Flexibility.** `attributes jsonb` holds per-category fields (size, voltage, ISBN…) without a migration for each new
  product type. It can get a GIN index if attribute filtering is needed later.

### Schema
See [`src/db/migrations/001_init.sql`](src/db/migrations/001_init.sql).
- `price_cents bigint` stores money as integer minor units, so there is no float rounding. `currency` sits next to it.
- `category` is a denormalized slug on the row, so the hot path needs no join. A real catalog would add a `categories`
  table (hierarchy, display names) and keep this slug, or an id, as the filter key.
- `id` is a **UUIDv7**, which is time-ordered. Inserts append to the right edge of the primary-key B-tree instead of
  splitting random pages. IDs can't be guessed or enumerated, and clients can't infer catalog size from them.
- `version` drives ETags and optimistic concurrency.
- **Soft delete** (`deleted_at`) keeps a deleted product resolvable for order history and audits. Every index is
  **partial** (`WHERE deleted_at IS NULL`), so deleted rows don't bloat or slow the read path, and a SKU can be reused
  after its product is deleted.

### Pagination: keyset (cursor), not OFFSET
`OFFSET n` makes the database read and discard `n` rows, so deep pages get linearly slower. It also skips or
duplicates items when rows are inserted while a client is paging. Instead, the cursor encodes the sort key and `id` of
the last row returned. The next page is `WHERE (price_cents, id) > ($key, $id) ORDER BY price_cents, id LIMIT n+1`.
- `id` breaks ties so the order is total. Without it, products with equal prices could be skipped at page boundaries.
  The tests seed many duplicate prices to cover this.
- There is one composite index per (filter, sort) shape: `(category, price_cents, id)`, `(category, created_at, id)`,
  `(price_cents, id)`, `(created_at, id)`. Descending sorts use a backward scan of the same index.
- The query fetches `limit + 1` rows to compute `next_cursor`, so it never runs `COUNT(*)`. Exact totals over
  a filtered set are expensive and rarely needed; if the UI wants one, an approximate count or a separate cached
  count endpoint is the cheaper option.
- Cursors are opaque base64url, carry the sort they were issued for (a mismatch returns `400`), and keep `created_at` as
  Postgres' microsecond-precision text. A JS `Date` would truncate to milliseconds and break boundaries.
- Trade-off: clients can go to the next page but can't jump to page 37. That fits infinite scroll and API consumers,
  and it is the normal choice at this scale.

**Measured** with `npm run explain` (300k rows, embedded Postgres on a laptop):

| Query | Plan | Time |
|---|---|---|
| category + price range, page 1 | Index Scan `products_cat_price_idx` | 0.15 ms |
| same, keyset page ~2,700 rows deep | Index Scan `products_cat_price_idx` | 0.12 ms |
| same depth with `OFFSET 2700` | Bitmap scan + sort of 2.9k rows | 9.6 ms |
| whole catalog, newest, keyset | Index Scan Backward `products_created_idx` | 0.06 ms |
| whole catalog, `OFFSET 250000` | Walks 250k index entries | 107 ms |
| `repository.list`, page 1 vs page 50 | | 2.0 ms vs 0.55 ms |

### Caching: reads ≫ writes
There are three layers, each fine with a different amount of staleness:
1. **HTTP.** `Cache-Control` (30 s for items, 10 s for lists, with `stale-while-revalidate`) and `ETag`, so a CDN or the
   browser absorbs most repeat traffic, and `If-None-Match` revalidation sends no body.
2. **In-process LRU** ([`service.ts`](src/products/service.ts)). This is a read-through cache for items (by id) and list
   pages (by normalized query). `lru-cache`'s `fetch()` **coalesces concurrent misses** into one DB query, which prevents
   a cache stampede on a hot product. A write invalidates the item and clears the list cache on that instance, giving
   read-your-writes for that client. Other instances converge within the TTL. That is acceptable for catalog data.
   Price and stock are authoritative at checkout, not on the listing page.
3. **Postgres.** The working set fits in `shared_buffers`. Read replicas take read traffic if one primary isn't
   enough. The repository would route `GET`s to a replica pool.

In a horizontally scaled deployment I'd move layer 2 to **Redis** behind the same interface. The service already treats
the cache as a separate concern, so this is a swap. Cross-instance invalidation would then use Redis deletes, or a
per-category generation counter in the cache key, which avoids clearing every list on each write.

### Writes and consistency
- **Validation.** `zod` checks every request (strict: unknown fields return `400`, so a typo can't silently do nothing),
  and DB constraints back it up.
- **Optimistic concurrency.** `PATCH`/`DELETE` accept `If-Match: "<version>"`. The `UPDATE … WHERE version = $n` is
  atomic, so of two concurrent editors exactly one wins and the other gets `412` with the current version. It is optional
  so simple clients still work.
- **Duplicate SKUs** map from the unique index (`23505`) to `409`. Because the database enforces it, there is no
  check-then-insert race.

### Code structure
```
src/
  app.ts                 Fastify app factory + uniform error mapping (dependency-injected → testable)
  server.ts              Entry point: connect, migrate, listen, graceful shutdown
  config.ts              Env-based config
  db/                    Db port (pg pool | PGlite), migration runner, SQL migrations
  products/
    schema.ts            zod schemas + types (the API contract)
    routes.ts            HTTP concerns: parsing, status codes, ETag/If-Match/Cache-Control
    service.ts           Caching + invalidation
    repository.ts        SQL: CRUD, dynamic filtered keyset query
    cursor.ts            Opaque cursor encode/decode
test/products.test.ts    Integration tests through HTTP (app.inject) against real Postgres
scripts/                 seed (real Postgres) and explain (300k-row plan/timing demo)
```
The tests run against **PGlite** (real Postgres compiled to WASM, in-process), not mocks. The same SQL, row comparisons,
partial indexes and error codes as production are exercised, and they run in about 1 s with no Docker.

### What I'd add next (out of scope here)
- **Text search:** a `tsvector` generated column + GIN index for `?q=`. Past simple search (typo tolerance, facets,
  relevance), I'd move to OpenSearch/Elasticsearch fed by change data capture (Debezium or an outbox table). Postgres
  stays the source of truth.
- **Facet counts** (how many items per price bucket or brand), precomputed or served from the search engine.
- **Auth:** writes are an admin or merchant concern (JWT/OAuth scopes), reads are public. Add **rate limiting** per client.
- **Observability:** OpenTelemetry traces, p95/p99 latency per route, cache hit ratio, slow-query log.
- **Idempotency-Key** on `POST` for safe client retries (SKU uniqueness already blocks most duplicates).
- **Bulk import** endpoint (`COPY` / batched upserts) for merchant feeds. Bulk writes should bump a generation counter
  instead of clearing caches row by row.
- **Migrations tooling** (e.g. node-pg-migrate) with a migrations table, instead of idempotent SQL files.
