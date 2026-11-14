import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/index.js';
import type { Product } from '../src/products/schema.js';
import { createTestDb } from './pglite.js';

let db: Db;
let app: FastifyInstance;

const cache = { itemTtlMs: 60_000, listTtlMs: 60_000, maxItems: 1000, maxLists: 1000 };

beforeAll(async () => {
  db = await createTestDb();
  app = buildApp({ db, cache });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.close();
});

let skuSeq = 0;
const newProduct = (over: Record<string, unknown> = {}) => ({
  sku: `SKU-${++skuSeq}`,
  name: `Product ${skuSeq}`,
  category: 'shoes',
  price_cents: 1999,
  ...over,
});

async function create(over: Record<string, unknown> = {}): Promise<Product> {
  const res = await app.inject({ method: 'POST', url: '/products', payload: newProduct(over) });
  expect(res.statusCode).toBe(201);
  return res.json();
}

/** Walks every page of a listing via next_cursor and returns all rows. */
async function listAll(query: string): Promise<Product[]> {
  const all: Product[] = [];
  let cursor: string | null = null;
  do {
    const url: string = `/products?${query}${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    all.push(...body.data);
    cursor = body.page.next_cursor;
  } while (cursor);
  return all;
}

describe('create', () => {
  it('creates a product with defaults, Location and ETag', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/products',
      payload: newProduct({ attributes: { color: 'red' } }),
    });
    expect(res.statusCode).toBe(201);
    const p = res.json();
    expect(p).toMatchObject({ currency: 'USD', stock: 0, description: '', version: 1, attributes: { color: 'red' } });
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.location).toBe(`/products/${p.id}`);
    expect(res.headers.etag).toBe('"1"');
  });

  it('rejects invalid payloads with 400', async () => {
    for (const payload of [
      { name: 'x' }, // missing fields
      newProduct({ price_cents: -1 }),
      newProduct({ price_cents: 10.5 }),
      newProduct({ category: 'Not A Slug' }),
      newProduct({ unknown_field: true }),
    ]) {
      const res = await app.inject({ method: 'POST', url: '/products', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/products',
      headers: { 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 on duplicate SKU', async () => {
    const p = await create();
    const res = await app.inject({ method: 'POST', url: '/products', payload: newProduct({ sku: p.sku }) });
    expect(res.statusCode).toBe(409);
  });
});

describe('read', () => {
  it('gets by id, supports conditional GET', async () => {
    const p = await create();
    const res = await app.inject({ method: 'GET', url: `/products/${p.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(p);
    expect(res.headers['cache-control']).toContain('max-age');

    const cond = await app.inject({ method: 'GET', url: `/products/${p.id}`, headers: { 'if-none-match': '"1"' } });
    expect(cond.statusCode).toBe(304);
  });

  it('404 for unknown id, 400 for malformed id', async () => {
    expect((await app.inject({ method: 'GET', url: '/products/0190a1b2-0000-7000-8000-000000000000' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/products/not-a-uuid' })).statusCode).toBe(400);
  });
});

describe('update', () => {
  it('patches fields, bumps version, and invalidates the cache', async () => {
    const p = await create({ price_cents: 1000 });
    await app.inject({ method: 'GET', url: `/products/${p.id}` }); // warm cache
    const res = await app.inject({ method: 'PATCH', url: `/products/${p.id}`, payload: { price_cents: 1500 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ price_cents: 1500, version: 2, name: p.name });
    expect(res.headers.etag).toBe('"2"');

    const after = await app.inject({ method: 'GET', url: `/products/${p.id}` });
    expect(after.json().price_cents).toBe(1500);
  });

  it('enforces optimistic concurrency with If-Match', async () => {
    const p = await create();
    const ok = await app.inject({
      method: 'PATCH',
      url: `/products/${p.id}`,
      headers: { 'if-match': '"1"' },
      payload: { stock: 5 },
    });
    expect(ok.statusCode).toBe(200);
    const stale = await app.inject({
      method: 'PATCH',
      url: `/products/${p.id}`,
      headers: { 'if-match': '"1"' },
      payload: { stock: 9 },
    });
    expect(stale.statusCode).toBe(412);
    expect((await app.inject({ method: 'GET', url: `/products/${p.id}` })).json().stock).toBe(5);
  });

  it('400 on empty patch, 404 on unknown id, 409 on SKU collision', async () => {
    const a = await create();
    const b = await create();
    expect((await app.inject({ method: 'PATCH', url: `/products/${a.id}`, payload: {} })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'PATCH', url: '/products/0190a1b2-0000-7000-8000-000000000000', payload: { stock: 1 } }))
        .statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/products/${a.id}`, payload: { sku: b.sku } })).statusCode).toBe(409);
  });
});

describe('delete', () => {
  it('soft-deletes, hides the product, and frees the SKU', async () => {
    const p = await create({ category: 'to-delete' });
    await app.inject({ method: 'GET', url: `/products/${p.id}` }); // warm cache
    await app.inject({ method: 'GET', url: '/products?category=to-delete' }); // warm list cache

    expect((await app.inject({ method: 'DELETE', url: `/products/${p.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/products/${p.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/products?category=to-delete' })).json().data).toHaveLength(0);
    expect((await app.inject({ method: 'DELETE', url: `/products/${p.id}` })).statusCode).toBe(404);

    await create({ sku: p.sku }); // SKU can be re-used once the old product is gone
  });
});

describe('list', () => {
  const cat = 'paging-test';
  let seeded: Product[] = [];

  beforeAll(async () => {
    // 57 products with many duplicate prices, so tie-breaking on id matters.
    for (let i = 0; i < 57; i++) seeded.push(await create({ category: cat, price_cents: (i % 7) * 100 }));
    await create({ category: 'other-category', price_cents: 300 });
  });

  it('paginates by price ascending with no gaps or duplicates', async () => {
    const all = await listAll(`category=${cat}&sort=price_asc&limit=10`);
    expect(all).toHaveLength(57);
    expect(new Set(all.map((p) => p.id)).size).toBe(57);
    const expected = [...seeded].sort((a, b) => a.price_cents - b.price_cents || (a.id < b.id ? -1 : 1));
    expect(all.map((p) => p.id)).toEqual(expected.map((p) => p.id));
  });

  it('paginates by price descending', async () => {
    const all = await listAll(`category=${cat}&sort=price_desc&limit=8`);
    const expected = [...seeded].sort((a, b) => b.price_cents - a.price_cents || (a.id < b.id ? 1 : -1));
    expect(all.map((p) => p.id)).toEqual(expected.map((p) => p.id));
  });

  it('paginates newest first (default sort)', async () => {
    const all = await listAll(`category=${cat}&limit=7`);
    // Order is (created_at DESC, id DESC); rows created in the same instant tie-break on id.
    expect(all).toHaveLength(57);
    expect(new Set(all.map((p) => p.id))).toEqual(new Set(seeded.map((p) => p.id)));
    for (let i = 1; i < all.length; i++) expect(all[i - 1]!.created_at >= all[i]!.created_at).toBe(true);
  });

  it('filters by price range (inclusive)', async () => {
    const all = await listAll(`category=${cat}&min_price=200&max_price=400&sort=price_asc`);
    expect(all.length).toBe(seeded.filter((p) => p.price_cents >= 200 && p.price_cents <= 400).length);
    expect(all.every((p) => p.price_cents >= 200 && p.price_cents <= 400 && p.category === cat)).toBe(true);
  });

  it('lists across categories when no category is given', async () => {
    const all = await listAll('min_price=300&max_price=300&sort=price_asc&limit=100');
    expect(all.some((p) => p.category === 'other-category')).toBe(true);
    expect(all.some((p) => p.category === cat)).toBe(true);
  });

  it('shows newly created products immediately (list cache invalidated)', async () => {
    const before = await listAll('category=fresh-cat');
    expect(before).toHaveLength(0);
    await create({ category: 'fresh-cat' });
    expect(await listAll('category=fresh-cat')).toHaveLength(1);
  });

  it('validates query parameters and cursors', async () => {
    const bad = [
      '/products?limit=0',
      '/products?limit=101',
      '/products?min_price=500&max_price=100',
      '/products?sort=random',
      '/products?cursor=garbage',
      '/products?foo=bar',
    ];
    for (const url of bad) expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(400);

    const first = (await app.inject({ method: 'GET', url: `/products?category=${cat}&sort=price_asc&limit=5` })).json();
    const crossed = await app.inject({
      method: 'GET',
      url: `/products?category=${cat}&sort=newest&cursor=${first.page.next_cursor}`,
    });
    expect(crossed.statusCode).toBe(400);
  });

  it('returns next_cursor = null on the last page', async () => {
    const res = (await app.inject({ method: 'GET', url: `/products?category=${cat}&limit=100` })).json();
    expect(res.data).toHaveLength(57);
    expect(res.page.next_cursor).toBeNull();
  });
});

describe('health', () => {
  it('reports ok', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ status: 'ok' });
  });
});
