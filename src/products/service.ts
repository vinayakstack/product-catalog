import { LRUCache } from 'lru-cache';
import { notFound } from '../lib/errors.js';
import type { ProductRepository } from './repository.js';
import type { CreateProductInput, ListQuery, Page, Product, UpdateProductInput } from './schema.js';

export interface CacheOptions {
  itemTtlMs: number;
  listTtlMs: number;
  maxItems: number;
  maxLists: number;
}

/**
 * Read-through caching in front of the repository.
 *
 * - Single items: cached by id, invalidated on every write to that id.
 * - List pages: cached by normalised query for a short TTL; any write clears the
 *   list cache on this instance (writes are rare, so this is cheap and gives
 *   read-your-writes locally). Other instances converge within `listTtlMs`.
 * - `LRUCache.fetch` coalesces concurrent misses for the same key into one DB
 *   query (stampede protection), and a delete during an in-flight fetch aborts
 *   that fetch so a stale value can't be written back after invalidation.
 *
 * In a multi-instance deployment this layer would be backed by Redis (same
 * interface) and/or sit behind a CDN honouring the Cache-Control/ETag headers.
 */
export class ProductService {
  private readonly items: LRUCache<string, Product>;
  private readonly lists: LRUCache<string, Page<Product>, ListQuery>;

  constructor(
    private readonly repo: ProductRepository,
    opts: CacheOptions,
  ) {
    this.items = new LRUCache<string, Product>({
      max: opts.maxItems,
      ttl: opts.itemTtlMs,
      fetchMethod: async (id) => this.repo.findById(id),
    });
    this.lists = new LRUCache<string, Page<Product>, ListQuery>({
      max: opts.maxLists,
      ttl: opts.listTtlMs,
      fetchMethod: async (_key, _stale, { context }) => this.repo.list(context),
    });
  }

  async get(id: string): Promise<Product> {
    const product = await this.items.fetch(id);
    if (!product) throw notFound('product');
    return product;
  }

  async list(q: ListQuery): Promise<Page<Product>> {
    const key = JSON.stringify([q.category, q.min_price, q.max_price, q.sort, q.limit, q.cursor]);
    return (await this.lists.fetch(key, { context: q }))!;
  }

  async create(input: CreateProductInput): Promise<Product> {
    const product = await this.repo.create(input);
    this.lists.clear();
    return product;
  }

  async update(id: string, patch: UpdateProductInput, expectedVersion?: number): Promise<Product> {
    try {
      const product = await this.repo.update(id, patch, expectedVersion);
      this.items.set(id, product);
      return product;
    } catch (e) {
      this.items.delete(id);
      throw e;
    } finally {
      this.lists.clear();
    }
  }

  async delete(id: string, expectedVersion?: number): Promise<void> {
    try {
      await this.repo.softDelete(id, expectedVersion);
    } finally {
      this.items.delete(id);
      this.lists.clear();
    }
  }
}
