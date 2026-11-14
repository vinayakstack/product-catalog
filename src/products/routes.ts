import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { badRequest } from '../lib/errors.js';
import { createProductSchema, idParamSchema, listQuerySchema, updateProductSchema, type Product } from './schema.js';
import type { ProductService } from './service.js';

const etag = (p: Product) => `"${p.version}"`;

/** Parses an `If-Match: "3"` header into a version number (or undefined if absent / `*`). */
function ifMatchVersion(req: FastifyRequest): number | undefined {
  const raw = req.headers['if-match'];
  if (raw === undefined || raw === '*') return undefined;
  const m = /^(?:W\/)?"(\d+)"$/.exec(String(raw).trim());
  if (!m) throw badRequest('If-Match must be an ETag previously returned by this API, e.g. "3"');
  return Number(m[1]);
}

const sendProduct = (reply: FastifyReply, p: Product, status = 200) =>
  reply.code(status).header('etag', etag(p)).send(p);

export const productRoutes =
  (service: ProductService): FastifyPluginAsync =>
  async (app) => {
    app.get('/products', async (req, reply) => {
      const q = listQuerySchema.parse(req.query);
      const page = await service.list(q);
      // Short shared-cache lifetime: listings tolerate a few seconds of staleness.
      reply.header('cache-control', 'public, max-age=10, stale-while-revalidate=30');
      return page;
    });

    app.get('/products/:id', async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const product = await service.get(id);
      reply.header('cache-control', 'public, max-age=30, stale-while-revalidate=60');
      if (req.headers['if-none-match'] === etag(product)) {
        return reply.code(304).header('etag', etag(product)).send();
      }
      return sendProduct(reply, product);
    });

    app.post('/products', async (req, reply) => {
      const input = createProductSchema.parse(req.body);
      const product = await service.create(input);
      reply.header('location', `/products/${product.id}`);
      return sendProduct(reply, product, 201);
    });

    app.patch('/products/:id', async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      const patch = updateProductSchema.parse(req.body);
      const product = await service.update(id, patch, ifMatchVersion(req));
      return sendProduct(reply, product);
    });

    app.delete('/products/:id', async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      await service.delete(id, ifMatchVersion(req));
      return reply.code(204).send();
    });
  };
