import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Db } from './db/index.js';
import { HttpError } from './lib/errors.js';
import { ProductRepository } from './products/repository.js';
import { productRoutes } from './products/routes.js';
import { ProductService, type CacheOptions } from './products/service.js';

export interface AppDeps {
  db: Db;
  cache: CacheOptions;
  logger?: boolean;
}

export function buildApp({ db, cache, logger = false }: AppDeps): FastifyInstance {
  const app = Fastify({ logger, bodyLimit: 64 * 1024 });
  const repo = new ProductRepository(db);
  const service = new ProductService(repo, cache);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'validation_error', message: 'request validation failed', details: err.flatten() },
      });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      // Fastify's own client errors (malformed JSON, body too large, wrong content-type...)
      return reply.code(status).send({ error: { code: 'bad_request', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal', message: 'internal server error' } });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'route not found' } }),
  );

  app.get('/healthz', async () => {
    await repo.ping();
    return { status: 'ok' };
  });

  app.register(productRoutes(service));
  return app;
}
