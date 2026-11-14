import { z } from 'zod';

const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase slug, e.g. "running-shoes"');

const fields = {
  sku: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, 'only letters, digits, ".", "_" and "-"'),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000),
  category: slug,
  price_cents: z.number().int().min(0).max(100_000_000_00),
  currency: z.string().regex(/^[A-Z]{3}$/, 'ISO-4217 code, e.g. "USD"'),
  stock: z.number().int().min(0),
  attributes: z
    .record(z.unknown())
    .refine((a) => JSON.stringify(a).length <= 16_384, 'attributes must serialize to <= 16KB'),
};

export const createProductSchema = z
  .object({
    sku: fields.sku,
    name: fields.name,
    description: fields.description.default(''),
    category: fields.category,
    price_cents: fields.price_cents,
    currency: fields.currency.default('USD'),
    stock: fields.stock.default(0),
    attributes: fields.attributes.default({}),
  })
  .strict();

export const updateProductSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'at least one field must be provided');

export const SORTS = ['newest', 'price_asc', 'price_desc'] as const;
export type Sort = (typeof SORTS)[number];

export const listQuerySchema = z
  .object({
    category: slug.optional(),
    min_price: z.coerce.number().int().min(0).optional(),
    max_price: z.coerce.number().int().min(0).optional(),
    sort: z.enum(SORTS).default('newest'),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(512).optional(),
  })
  .strict()
  .refine((q) => q.min_price === undefined || q.max_price === undefined || q.min_price <= q.max_price, {
    message: 'min_price must be <= max_price',
    path: ['min_price'],
  });

export const idParamSchema = z.object({ id: z.string().uuid() });

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;

export interface Product {
  id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  price_cents: number;
  currency: string;
  stock: number;
  attributes: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Page<T> {
  data: T[];
  page: { limit: number; next_cursor: string | null };
}
