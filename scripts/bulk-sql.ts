/**
 * Set-based synthetic data: N products over 50 categories with prices from
 * $1 to $1,000 and creation times spread across the last year. Done inside
 * Postgres with generate_series, so 300k rows load in seconds.
 */
export const bulkInsertSql = (n: number) => `
  INSERT INTO products (id, sku, name, description, category, price_cents, currency, stock, attributes, created_at, updated_at)
  SELECT
    ('00000000-0000-7000-8000-' || lpad(to_hex(i), 12, '0'))::uuid,
    'SEED-' || i,
    'Product ' || i,
    'Synthetic product ' || i,
    'category-' || (i % 50),
    100 + ((i * 7919) % 99900),
    'USD',
    (i * 31) % 500,
    jsonb_build_object('color', (ARRAY['red','green','blue','black'])[1 + i % 4]),
    now() - ((i * 104729) % 31536000) * interval '1 second',
    now()
  FROM generate_series(1::bigint, ${n}::bigint) AS i
  ON CONFLICT DO NOTHING;
  ANALYZE products;
`;
