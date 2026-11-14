import type { Db } from '../db/index.js';
import { conflict, notFound, preconditionFailed } from '../lib/errors.js';
import { uuidv7 } from '../lib/uuidv7.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import type { CreateProductInput, ListQuery, Page, Product, UpdateProductInput } from './schema.js';

const COLUMNS = `id, sku, name, description, category, price_cents, currency, stock, attributes,
  version, created_at, updated_at`;

interface Row extends Omit<Product, 'created_at' | 'updated_at'> {
  created_at: Date | string;
  updated_at: Date | string;
  created_at_key?: string;
}

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function toProduct(r: Row): Product {
  return {
    id: r.id,
    sku: r.sku,
    name: r.name,
    description: r.description,
    category: r.category,
    price_cents: Number(r.price_cents),
    currency: r.currency,
    stock: r.stock,
    attributes: r.attributes,
    version: r.version,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505';

// For each sort: the key column, direction, and the row-comparison operator that
// means "after the cursor". Row comparison `(a, b) > ($1, $2)` maps directly onto
// a composite B-tree index range, which is what makes keyset pagination cheap.
const SORT_SPEC = {
  newest: { col: 'created_at', dir: 'DESC', op: '<', cast: '::timestamptz' },
  price_asc: { col: 'price_cents', dir: 'ASC', op: '>', cast: '::bigint' },
  price_desc: { col: 'price_cents', dir: 'DESC', op: '<', cast: '::bigint' },
} as const;

export class ProductRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreateProductInput): Promise<Product> {
    try {
      const { rows } = await this.db.query<Row>(
        `INSERT INTO products (id, sku, name, description, category, price_cents, currency, stock, attributes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         RETURNING ${COLUMNS}`,
        [
          uuidv7(),
          input.sku,
          input.name,
          input.description,
          input.category,
          input.price_cents,
          input.currency,
          input.stock,
          JSON.stringify(input.attributes),
        ],
      );
      return toProduct(rows[0]!);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(`a product with sku "${input.sku}" already exists`);
      throw e;
    }
  }

  async findById(id: string): Promise<Product | undefined> {
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM products WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ? toProduct(rows[0]) : undefined;
  }

  /**
   * Partial update with optional optimistic concurrency: when `expectedVersion`
   * is given the UPDATE only matches that version, so two clients editing the
   * same product can't silently overwrite each other (lost update).
   */
  async update(id: string, patch: UpdateProductInput, expectedVersion?: number): Promise<Product> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      params.push(key === 'attributes' ? JSON.stringify(value) : value);
      sets.push(`${key} = $${params.length}${key === 'attributes' ? '::jsonb' : ''}`);
    }
    let where = 'id = $1 AND deleted_at IS NULL';
    if (expectedVersion !== undefined) {
      params.push(expectedVersion);
      where += ` AND version = $${params.length}`;
    }
    try {
      const { rows } = await this.db.query<Row>(
        `UPDATE products SET ${sets.join(', ')}, version = version + 1, updated_at = now()
         WHERE ${where} RETURNING ${COLUMNS}`,
        params,
      );
      if (rows[0]) return toProduct(rows[0]);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(`a product with sku "${patch.sku}" already exists`);
      throw e;
    }
    // Nothing updated: distinguish "doesn't exist" from "version mismatch".
    const current = await this.findById(id);
    if (!current) throw notFound('product');
    throw preconditionFailed(`version mismatch: current version is ${current.version}`);
  }

  async softDelete(id: string, expectedVersion?: number): Promise<void> {
    const params: unknown[] = [id];
    let where = 'id = $1 AND deleted_at IS NULL';
    if (expectedVersion !== undefined) {
      params.push(expectedVersion);
      where += ' AND version = $2';
    }
    const { rows } = await this.db.query(
      `UPDATE products SET deleted_at = now(), version = version + 1, updated_at = now()
       WHERE ${where} RETURNING id`,
      params,
    );
    if (rows.length) return;
    if (!(await this.findById(id))) throw notFound('product');
    throw preconditionFailed('version mismatch');
  }

  async list(q: ListQuery): Promise<Page<Product>> {
    const spec = SORT_SPEC[q.sort];
    const where = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);

    if (q.category !== undefined) where.push(`category = ${p(q.category)}`);
    if (q.min_price !== undefined) where.push(`price_cents >= ${p(q.min_price)}`);
    if (q.max_price !== undefined) where.push(`price_cents <= ${p(q.max_price)}`);
    if (q.cursor) {
      const c = decodeCursor(q.cursor, q.sort);
      where.push(`(${spec.col}, id) ${spec.op} (${p(c.key)}${spec.cast}, ${p(c.id)}::uuid)`);
    }

    // Fetch one extra row to learn whether another page exists without COUNT(*).
    const { rows } = await this.db.query<Row>(
      `SELECT ${COLUMNS}, created_at::text AS created_at_key
         FROM products
        WHERE ${where.join(' AND ')}
        ORDER BY ${spec.col} ${spec.dir}, id ${spec.dir}
        LIMIT ${p(q.limit + 1)}`,
      params,
    );

    const hasMore = rows.length > q.limit;
    const pageRows = hasMore ? rows.slice(0, q.limit) : rows;
    const last = pageRows[pageRows.length - 1];
    const next_cursor =
      hasMore && last
        ? encodeCursor({
            sort: q.sort,
            // created_at is passed back as Postgres' own text form so the
            // microsecond precision survives (a JS Date would truncate to ms
            // and skip/duplicate rows at page boundaries).
            key: q.sort === 'newest' ? last.created_at_key! : Number(last.price_cents),
            id: last.id,
          })
        : null;

    return { data: pageRows.map(toProduct), page: { limit: q.limit, next_cursor } };
  }

  async ping(): Promise<void> {
    await this.db.query('SELECT 1');
  }
}
