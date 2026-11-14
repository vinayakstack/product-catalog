-- Products table. Design notes (see README for the full reasoning):
--  * Money is stored as integer minor units (cents) to avoid float rounding.
--  * `category` is a denormalized slug so the hot list query never needs a join.
--  * `attributes` holds free-form, category-specific data (size, colour, ...)
--    without forcing schema migrations for every new product type.
--  * `version` drives optimistic concurrency (If-Match / ETag).
--  * Rows are soft-deleted (`deleted_at`) so historical orders can still resolve
--    a product; every hot index is PARTIAL on `deleted_at IS NULL` so deleted
--    rows cost nothing on reads.
CREATE TABLE IF NOT EXISTS products (
  id           uuid        PRIMARY KEY,
  sku          text        NOT NULL,
  name         text        NOT NULL,
  description  text        NOT NULL DEFAULT '',
  category     text        NOT NULL,
  price_cents  bigint      NOT NULL CHECK (price_cents >= 0),
  currency     char(3)     NOT NULL DEFAULT 'USD',
  stock        integer     NOT NULL DEFAULT 0 CHECK (stock >= 0),
  attributes   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  version      integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

-- SKU is unique among live products (a deleted SKU may be re-used).
CREATE UNIQUE INDEX IF NOT EXISTS products_sku_live_uq
  ON products (sku) WHERE deleted_at IS NULL;

-- Keyset-pagination indexes. Each one matches exactly one (filter, sort) shape
-- so that list queries are a single index range scan + LIMIT, independent of
-- how deep the client has paged. The trailing `id` is the tie-breaker that makes
-- the sort order total (required for stable cursors).
--   category + price range, sorted by price (asc, or desc via backward scan)
CREATE INDEX IF NOT EXISTS products_cat_price_idx
  ON products (category, price_cents, id) WHERE deleted_at IS NULL;
--   category, sorted by newest
CREATE INDEX IF NOT EXISTS products_cat_created_idx
  ON products (category, created_at, id) WHERE deleted_at IS NULL;
--   whole catalog, price range / sorted by price
CREATE INDEX IF NOT EXISTS products_price_idx
  ON products (price_cents, id) WHERE deleted_at IS NULL;
--   whole catalog, sorted by newest
CREATE INDEX IF NOT EXISTS products_created_idx
  ON products (created_at, id) WHERE deleted_at IS NULL;
