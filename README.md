# Product Catalog API

**The engine behind an online store's shelves.** This service stores a store's products and answers every
"show me running shoes under $100, cheapest first" in well under a millisecond. It was built for a catalog of
a few hundred thousand items, where shoppers browsing vastly outnumber staff editing.

Built with TypeScript, Fastify and PostgreSQL. 19 automated tests, all passing.

> **How to read this page.** Each chapter tells the idea in plain language first. If you write code, open the
> **"Under the hood"** section after it for the technical detail. If you don't, you can skip those and still
> follow the whole story.

---

## Contents

1. [The problem: a store where everyone browses](#1-the-problem-a-store-where-everyone-browses)
2. [Choosing the warehouse](#2-choosing-the-warehouse)
3. [The index cards](#3-the-index-cards)
4. [Bookmarks, not page numbers](#4-bookmarks-not-page-numbers)
5. [A shop assistant with a good memory](#5-a-shop-assistant-with-a-good-memory)
6. [Two people, one price tag](#6-two-people-one-price-tag)
7. [The small rules that prevent big mistakes](#7-the-small-rules-that-prevent-big-mistakes)
8. [How we know it works](#8-how-we-know-it-works)
9. [What I'd build next](#9-what-id-build-next)
10. [Reference: running it, the API, the code map](#10-reference)

---

## 1. The problem: a store where everyone browses

Picture a huge department store with **300,000 products** on its shelves.

Thousands of people walk the aisles every minute. They browse, filter and compare: *"Show me jackets. Only
the ones between $50 and $150. Cheapest first. Next page, next page, next page…"*

Meanwhile a handful of staff quietly add new products, change prices and retire old stock. For every
person changing a price tag, there are hundreds or thousands of people just looking.

That imbalance shapes every decision in this project:

- **Looking must be instant**, no matter how big the store gets or how deep into the results someone scrolls.
- **Changing must be correct.** Changes happen rarely, so they can afford to be careful.

The service does five things, which programmers call **CRUD** plus listing:

| What a person wants | What the service does |
|---|---|
| "Add this new product" | **Create** |
| "Show me product #123" | **Read** |
| "Change its price to $19.99" | **Update** |
| "Take it off the shelves" | **Delete** |
| "Show me jackets, $50–$150, cheapest first" | **List**, with filters and pages |

---

## 2. Choosing the warehouse

Before building anything, you decide where the products will live. Software calls this the **datastore**.
There are several kinds, and each suits a different job:

- A **key-value store** works like a coat check. Hand over ticket #123 and you get coat #123 back very fast.
  But ask it for "all the blue coats under $100" and it has no idea.
- A **document store** works like a filing cabinet of folders. It's flexible, but to answer "cheapest first"
  questions quickly you still have to organise it like a library.
- A **relational database** works like a well-run library. Everything is catalogued, there are strict rules
  about what can go on the shelves, and it is very good at "find everything matching X, sorted by Y".

I chose the library: **PostgreSQL**.

The deciding fact is size. 300,000 products, with all their index cards (see next chapter), take up about
**300 MB**. That's roughly the size of one phone video, and it fits comfortably in a single server's memory.
There is no need for anything bigger or more exotic. Picking the simplest tool that comfortably does the job
is a design decision in itself.

<details>
<summary><b>Under the hood</b></summary>

- **The query shape fits a B-tree.** Equality on `category`, a range on `price_cents`, then `ORDER BY` is
  exactly what a composite B-tree index answers in one range scan. A KV store can't range-scan secondary
  attributes, and a document store would need the same indexes anyway.
- **Correctness for free:** a unique index on SKU, `CHECK (price_cents >= 0)`, and atomic conditional
  `UPDATE … WHERE version = $n` for optimistic locking.
- **Flexibility where it's needed:** `attributes jsonb` holds per-category fields (shoe size, voltage, ISBN)
  without a schema migration for each new product type. It can get a GIN index later if filtering on
  attributes is needed.
- **Schema:** [`src/db/migrations/001_init.sql`](src/db/migrations/001_init.sql).

</details>

---

## 3. The index cards

Imagine walking into a library with 300,000 books and no catalogue. To find every cookbook between $10 and
$20, you would have to pull every single book off every shelf. That is what a database does without an
**index**. It's called a *full scan*, and it is slow.

Now imagine a drawer of index cards **sorted first by category, then by price**. To find cookbooks
between $10 and $20 you open the "cookbook" section, flip to $10 and read cards until you pass $20.
You never touch a novel or a $50 cookbook.

The service keeps **four drawers like this**, one for each question shoppers actually ask:

| Drawer is sorted by… | Answers questions like… |
|---|---|
| category → price | "Jackets between $50 and $150, cheapest (or priciest) first" |
| category → date added | "Newest jackets" |
| price | "Everything under $20, cheapest first" |
| date added | "Newest arrivals across the whole store" |

To answer "most expensive first", the database reads the same drawer from the back. No extra drawer needed.

One more detail: when a product is deleted, its card is **removed from the drawers** even though the product
record is kept in an archive (more on that in chapter 7). So retired products never slow down browsing.

<details>
<summary><b>Under the hood</b></summary>

```sql
CREATE INDEX products_cat_price_idx   ON products (category, price_cents, id) WHERE deleted_at IS NULL;
CREATE INDEX products_cat_created_idx ON products (category, created_at, id)  WHERE deleted_at IS NULL;
CREATE INDEX products_price_idx       ON products (price_cents, id)           WHERE deleted_at IS NULL;
CREATE INDEX products_created_idx     ON products (created_at, id)            WHERE deleted_at IS NULL;
```

- One composite index per (filter, sort) shape, so every list query is a single index range scan + `LIMIT`.
- Descending sorts use `Index Scan Backward` on the same index.
- The trailing `id` makes the ordering total (needed for the cursors in the next chapter).
- **Partial** (`WHERE deleted_at IS NULL`): soft-deleted rows don't bloat the indexes or the read path. The
  same trick makes SKU uniqueness apply only to live products, so a retired SKU can be reused.

</details>

---

## 4. Bookmarks, not page numbers

Shoppers don't see all 6,000 jackets at once. They see 20, then the next 20, and so on. This is
**pagination**, and there are two ways to do it.

**The obvious way: page numbers.** "Give me page 300" means "skip the first 5,980 jackets, then show 20".
The catch is that the database can't jump to item 5,981. It has to *count past* every one of those 5,980
items first, like finding page 300 of a book by turning pages one at a time from the start.
The deeper you go, the slower it gets.

There's a second, sneakier problem. If a new jacket is added while you're browsing, everything shifts down
by one. The last jacket on your page 3 becomes the first on page 4, and you see it twice. If a jacket is
removed, you skip one without ever knowing.

**The approach used here: bookmarks.** At the bottom of each page the service hands back a small
**bookmark** (programmers call it a **cursor**). It says, in effect, *"you stopped at the $79.99 jacket with
ID 8f3a…"*. To get the next page, you hand the bookmark back, and the database opens the index-card drawer
at exactly that spot and reads the next 20. No counting, and no shifting when other products come and go.

**I measured it** on 300,000 products:

| Request | With a bookmark | With page numbers |
|---|---|---|
| Jackets in a price range, about 2,700 items deep | **0.12 ms** | 9.6 ms (80× slower) |
| Whole store, 250,000 items deep | **0.06 ms** | 107 ms (1,800× slower) |

The bookmark version takes the same time on page 1 as on page 5,000. The page-number version keeps getting
slower.

**The trade-off.** With bookmarks you can go to the *next* page, but you can't jump straight to "page 37".
That suits infinite scroll, "Load more" buttons and apps talking to the API, which covers almost all real
traffic. It is the standard choice at this scale.

<details>
<summary><b>Under the hood</b></summary>

This technique is called **keyset pagination**. The next page is:

```sql
WHERE category = $1 AND price_cents BETWEEN $2 AND $3
  AND (price_cents, id) > ($cursor_price, $cursor_id)   -- row comparison → index range start
ORDER BY price_cents, id
LIMIT 21                                                 -- limit + 1 → tells us if there's a next page
```

- **`id` as tie-breaker:** without it, two $79.99 jackets straddling a page boundary could be skipped or
  repeated. The tests deliberately seed many identical prices to prove this works.
- **`LIMIT n+1` instead of `COUNT(*)`:** fetching one extra row tells us whether there is a next page without
  counting the whole filtered set. Exact totals are expensive and rarely needed. If the UI wants one, an
  approximate or separately cached count is the cheaper option.
- **Cursors are opaque** base64url (`[sort, key, id]`). A cursor carries the sort it was issued for, and
  using it with a different sort returns `400`.
- **Precision gotcha:** for the "newest" sort, `created_at` goes into the cursor as Postgres' own text with
  microsecond precision. A JavaScript `Date` keeps only milliseconds and would skip or repeat rows at page
  boundaries.
- Run `npm run explain` to see the actual query plans: index range scans for keyset, a sort of thousands of
  rows or a walk of 250k index entries for OFFSET.
- Code: [`repository.ts`](src/products/repository.ts) (`list`), [`cursor.ts`](src/products/cursor.ts).

</details>

---

## 5. A shop assistant with a good memory

Even with perfect index cards, walking to the stockroom takes *some* time. And people ask the same questions
over and over. Thousands of shoppers open the same bestselling sneaker page every hour.

So the service keeps a **short-term memory**, called a **cache**, at three levels. Think of three people
between the shopper and the stockroom:

1. **The shop window (the shopper's browser, or a CDN).** Every answer carries a note saying *"this is good for
   the next 30 seconds"*. During that time the shopper's own browser, or a delivery network near them,
   reuses its copy and the request never reaches the store. When the time is up, the browser can ask "has this
   changed?" If not, the store just answers "no", without resending the whole product.
2. **The shop assistant (memory inside the service).** The assistant remembers recent answers: popular
   products, and popular searches like "jackets, cheapest first". If someone asks again soon, the assistant
   answers from memory instead of walking to the stockroom.
3. **The stockroom itself (PostgreSQL).** The whole catalog fits in the database server's memory, so even a
   trip to the stockroom is quick.

**The rush-hour trick.** Suppose 500 people ask about the same product in the same instant, just as the
assistant's memory of it has expired. A naive assistant would make 500 separate trips to the stockroom.
This one makes **one trip** and gives all 500 people the same answer. Engineers call the problem a
*cache stampede*, and the fix is built in.

**Keeping memory honest.** When staff change a product, the assistant immediately forgets the old answer, so
the person who made the change sees it straight away. The remembered search results are short-lived (10
seconds) for the same reason. For a catalog that is fine: the price that really counts is the one checked
again at checkout.

<details>
<summary><b>Under the hood</b></summary>

- **HTTP:** `Cache-Control: public, max-age=30, stale-while-revalidate=60` on items (10 s on lists), plus
  `ETag` / `If-None-Match` → `304 Not Modified`.
- **In-process LRU** ([`service.ts`](src/products/service.ts)) using `lru-cache`:
  - items cached by id, list pages cached by the normalised query;
  - `cache.fetch()` **coalesces concurrent misses** into one DB query (stampede protection);
  - a `delete`/`set` during an in-flight fetch aborts that fetch, so a stale value can't be written back
    after invalidation;
  - writes invalidate the item and clear the list cache *on this instance* (read-your-writes). Other
    instances converge within the TTL.
- **Scaling out:** with several instances, move this layer to **Redis** behind the same interface, and use a
  per-category generation counter in list cache keys instead of clearing everything on each write. Add
  **read replicas** for the database and route `GET`s to them.

</details>

---

## 6. Two people, one price tag

Here's a quiet disaster that happens in a lot of software.

At 10:00:00, **Asha** opens the "Classic Tee" to change its price from $20 to $18.
At 10:00:05, **Ben** opens the same product to change the stock count from 40 to 35.
Asha saves. Then Ben saves, and his screen still holds the *old* price of $20. **Asha's price change is gone.**
Nobody gets an error, and nobody notices until a customer complains.

This is called a **lost update**. The service prevents it with a **version number**, like a revision
number on a shared document:

- Every product carries a version: 1, 2, 3, and so on. Each save bumps it by one.
- When Asha and Ben opened the tee, it was version **1**. Each of them says *"save this, but only if it's
  still version 1"*.
- Asha saves first: it was version 1, so the save goes through and it becomes version **2**.
- Ben's save says "only if it's still version 1". It isn't, so the service refuses and tells him:
  *"Someone changed this since you opened it. It's now version 2. Reload and try again."*

No one's work silently disappears. Tools that don't need this protection can simply leave the version out.

<details>
<summary><b>Under the hood</b></summary>

- Standard HTTP: responses carry `ETag: "<version>"`. Clients send `If-Match: "<version>"` on `PATCH`/`DELETE`.
- One atomic statement, so there's no race window between "check" and "write":
  ```sql
  UPDATE products SET …, version = version + 1, updated_at = now()
   WHERE id = $1 AND deleted_at IS NULL AND version = $n
   RETURNING …
  ```
- Zero rows updated → look the row up: missing gives `404`, a different version gives `412 Precondition Failed`.
- **Duplicate SKUs** use the same philosophy. The unique index rejects them (`23505` → `409 Conflict`)
  instead of checking first and inserting second, which would leave a race window.

</details>

---

## 7. The small rules that prevent big mistakes

None of these are glamorous. Each one prevents a real, expensive kind of bug.

**💰 Money is stored in whole cents.** Computers are surprisingly bad at decimals. In most programming
languages, `0.1 + 0.2` comes out as `0.30000000000000004`. That's fine for a game, but not for prices.
So $19.99 is stored as the whole number **1999**, and there are no rounding surprises, ever.

**🗄️ Deleting means archiving.** When a product is removed from the store, it disappears from every search
and page, but its record is kept in the archive. Why? Last month's orders still point at it, and a receipt
should never say "unknown product". Its SKU (the store's product code) becomes free to use again.

**🎫 Product IDs work like timestamped ticket numbers.** Each product gets an ID that starts with the moment
it was created, followed by random characters. Because new IDs always land at the "end" of the list, the
database files them efficiently. Because of the random part, no one can guess other products' IDs or work
out how big the catalog is by counting.

**🚪 A strict doorman checks every request.** Every incoming request is checked before it gets in. Prices
must be whole, non-negative numbers. Categories must look like `running-shoes`. Unknown fields are
**rejected, not ignored**. If someone sends `"prise": 1999` (a typo), the service says so, instead of
pretending everything went fine while the price never changed.

**🧾 Every error looks the same.** Whatever goes wrong, the answer has the same shape: a code, a message and
details. Apps calling the service only need to learn one pattern.

<details>
<summary><b>Under the hood</b></summary>

- `price_cents bigint CHECK (price_cents >= 0)` + `currency char(3)`.
- Soft delete via `deleted_at timestamptz`, with partial indexes (chapter 3) and a partial unique index on SKU.
- **UUIDv7** ([`uuidv7.ts`](src/lib/uuidv7.ts)): 48-bit millisecond timestamp + random bits (RFC 9562).
  Inserts append to the right edge of the primary-key B-tree instead of splitting random pages like UUIDv4.
- **Validation:** `zod` schemas with `.strict()` ([`schema.ts`](src/products/schema.ts)). DB constraints are a
  second line of defence.
- **Errors:** `{ "error": { "code": "validation_error" | "not_found" | "conflict" | "precondition_failed" | …,
  "message": "…", "details": … } }`, mapped centrally in [`app.ts`](src/app.ts).
- Request bodies are capped at 64 KB, and `attributes` at 16 KB.

</details>

---

## 8. How we know it works

There are 19 automated tests that act like a very picky customer. They create products, try to break the
rules, edit products at the same time, delete them, and page through results. Every run checks every
promise in this README.

The best example is the paging test. It creates 57 products where **many share the same price**, then pages
through them 10 at a time, cheapest first, then most expensive first, then newest first. After each walk it
checks that every product appeared **exactly once**, in exactly the right order: no gaps and no repeats.

The tests run against **a real PostgreSQL database**, not an imitation of one. It's a version of Postgres
that runs inside the test program itself, so anyone can run the full suite in about one second without
installing a database.

<details>
<summary><b>Under the hood</b></summary>

- **Vitest** + Fastify's `app.inject()`: full HTTP round trips with no open port.
- **PGlite** (Postgres compiled to WASM, in-process) runs the same SQL, row comparisons, partial indexes and
  error codes as production. See [`test/products.test.ts`](test/products.test.ts).
- Coverage includes validation, malformed JSON, `409` on SKU collisions, `304` conditional GET, `412` on stale
  `If-Match`, cache invalidation after update, delete and create, soft delete freeing the SKU, cursor tampering
  or sort mismatch → `400`, and exact ordering across all three sorts with duplicate keys.
- `npm run explain` loads 300k synthetic products and prints real query plans and timings.

</details>

---

## 9. What I'd build next

This version does its one job well. A real store would grow it in roughly this order:

- **🔎 Search by name.** "Find 'blue running shoe'", tolerant of typos. Start with Postgres' built-in text
  search, then move to a dedicated search engine (OpenSearch or Elasticsearch) fed automatically from the
  database, which stays the source of truth.
- **📊 Filter counts.** "Under $50 (1,204) · $50–$100 (873)…" as shown in shop sidebars.
- **🔐 Who can change what.** Anyone can browse, but only signed-in staff can edit. Add rate limits so
  no single client can flood the store.
- **📈 Dashboards and alerts.** How fast are answers (including the slowest 1%)? How often does the
  assistant's memory help? Which database queries are slow?
- **📦 Bulk import.** Load a supplier's spreadsheet of 50,000 products in one go.
- **🔁 Safe retries.** If a phone loses signal mid-request and retries "create product", make sure only one
  product gets created (an `Idempotency-Key` header).

---

## 10. Reference

### Run it

```bash
npm install
npm test                                        # 19 tests against real Postgres (in-process), ~1 second
DATABASE_URL=pglite://memory npm start          # run the API on :3000 with an embedded database, no Docker
docker compose up --build                       # or: API + PostgreSQL 17
DATABASE_URL=postgres://catalog:catalog@localhost:5432/catalog npm run seed -- 300000
npm run explain                                 # load 300k products, print query plans + timings
```

### The API

| Method | Path | What it does |
|---|---|---|
| `POST` | `/products` | Create. Returns `201` with `Location` and `ETag`. `409` if the SKU is taken. |
| `GET` | `/products/:id` | Read one. Supports `If-None-Match` → `304`. |
| `GET` | `/products` | List. `category`, `min_price`, `max_price` (cents, inclusive), `sort` = `newest` \| `price_asc` \| `price_desc`, `limit` (1–100, default 20), `cursor`. |
| `PATCH` | `/products/:id` | Partial update. Optional `If-Match: "<version>"` → `412` if stale. |
| `DELETE` | `/products/:id` | Soft delete, `204`. Optional `If-Match`. |
| `GET` | `/healthz` | Checks the database connection. |

```jsonc
// POST /products
{ "sku": "TSHIRT-001", "name": "Classic Tee", "category": "apparel", "price_cents": 1999,
  "currency": "USD", "stock": 40, "attributes": { "size": "M", "color": "navy" } }

// GET /products?category=apparel&min_price=1000&max_price=5000&sort=price_asc&limit=20
{ "data": [ { "id": "01a1d821-…", "sku": "TSHIRT-001", "price_cents": 1999, "version": 1, … } ],
  "page": { "limit": 20, "next_cursor": "WyJwcmljZV9hc2MiLDE5OTks…" } }   // the "bookmark"
```

### Code map

```
src/
  app.ts                 Builds the web app; turns every error into the same shape
  server.ts              Starts everything: connect, set up tables, listen, shut down cleanly
  config.ts              Settings from environment variables
  db/                    Database connection (real Postgres or embedded), table setup (SQL)
  products/
    schema.ts            The doorman: what a valid request looks like
    routes.ts            The front desk: URLs, status codes, caching headers, version checks
    service.ts           The shop assistant's memory (cache) and when to forget
    repository.ts        The trips to the stockroom: all SQL, including bookmark paging
    cursor.ts            Making and reading bookmarks
test/products.test.ts    The picky customer: 19 end-to-end tests
scripts/                 Fill a database with 300k products; measure query speed
```
