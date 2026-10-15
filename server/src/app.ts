import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { HttpError, Sessions } from './lib/auth.js';
import { createMailer, type Mailer } from './lib/mailer.js';
import { Notifier } from './services/notify.js';
import { customerRoutes } from './routes/customer.js';
import { walletRoutes } from './routes/wallet.js';
import { appleWebServiceRoutes } from './routes/appleWebService.js';
import { staffRoutes } from './routes/staff.js';
import { adminRoutes } from './routes/admin.js';

export interface Services {
  cfg: Config;
  db: Db;
  sessions: Sessions;
  mailer: Mailer;
  notifier: Notifier;
  log: (m: string) => void;
}

declare module 'fastify' {
  interface FastifyInstance {
    svc: Services;
  }
}

export async function buildApp(cfg: Config, db: Db, opts: { logger?: boolean; mailer?: Mailer } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? true,
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });
  const log = (m: string) => app.log.info(m);
  const svc: Services = {
    cfg,
    db,
    sessions: new Sessions(cfg.secret, cfg.publicUrl.startsWith('https://')),
    mailer: opts.mailer ?? createMailer(cfg, log),
    notifier: new Notifier(db, cfg, log),
    log,
  };
  app.decorate('svc', svc);
  app.addHook('onClose', async () => svc.notifier.close());

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    return payload;
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.message, code: err.code });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'Please check the highlighted fields', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    if (err.code === '23505') {
      return reply.status(409).send({ error: 'That already exists' });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'Something went wrong' });
  });

  app.get('/healthz', async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });

  await app.register(customerRoutes, { prefix: '/api' });
  await app.register(walletRoutes, { prefix: '/api/wallet' });
  await app.register(appleWebServiceRoutes, { prefix: '/api/wallet/apple' });
  await app.register(staffRoutes, { prefix: '/api/staff' });
  await app.register(adminRoutes, { prefix: '/api/admin' });

  // Serve the built web app (customer, staff and admin SPA) with client-side routing fallback.
  const webDist = resolve(cfg.webDist);
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.status(404).send({ error: 'Not found' });
    });
  }

  return app;
}
