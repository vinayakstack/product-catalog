import { badRequest } from '../lib/errors.js';
import type { Sort } from './schema.js';

/**
 * Opaque keyset cursor: the sort key + id of the last row on the previous page.
 * The next page is "rows strictly after (key, id) in sort order", which the
 * matching composite index answers with one range scan, so page 5,000 costs
 * the same as page 1 (unlike OFFSET, which reads and discards every skipped row).
 * The sort is embedded so a cursor can't be replayed against a different order.
 */
export interface Cursor {
  sort: Sort;
  key: string | number; // created_at (exact Postgres text, microseconds) or price_cents
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.sort, c.key, c.id])).toString('base64url');
}

export function decodeCursor(raw: string, expectedSort: Sort): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('invalid cursor');
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw badRequest('invalid cursor');
  const [sort, key, id] = parsed as [unknown, unknown, unknown];
  if (sort !== expectedSort) throw badRequest('cursor was issued for a different sort order');
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('invalid cursor');
  if (sort === 'newest' ? typeof key !== 'string' : !Number.isInteger(key)) throw badRequest('invalid cursor');
  return { sort: sort as Sort, key: key as string | number, id };
}
