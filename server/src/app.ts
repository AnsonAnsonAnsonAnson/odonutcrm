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
import { createSms, type SmsSender } from './lib/sms.js';
import { posRoutes } from './routes/pos.js';
import { Notifier } from './services/notify.js';
import { syncStoredCredentials } from './services/apple/credentials.js';
import { customerRoutes } from './routes/customer.js';
import { walletRoutes } from './routes/wallet.js';
import { appleWebServiceRoutes } from './routes/appleWebService.js';
import { staffRoutes } from './routes/staff.js';
import { securityRoutes } from './routes/security.js';
import { audit } from './lib/security.js';
import { adminRoutes } from './routes/admin.js';
import { defaultGoogleKeys, type GoogleKeys } from './lib/google.js';

export interface Services {
  cfg: Config;
  db: Db;
  sessions: Sessions;
  mailer: Mailer;
  sms: SmsSender;
  notifier: Notifier;
  /** Google's public keys for checking "Sign in with Google" tokens (tests pass their own). */
  googleKeys: GoogleKeys;
  log: (m: string) => void;
}

declare module 'fastify' {
  interface FastifyInstance {
    svc: Services;
  }
}

export async function buildApp(
  cfg: Config,
  db: Db,
  opts: { logger?: boolean; mailer?: Mailer; sms?: SmsSender; googleKeys?: GoogleKeys } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? true,
    trustProxy: cfg.trustProxy,
    bodyLimit: 256 * 1024,
  });
  const log = (m: string) => app.log.info(m);
  // Apple Wallet credentials made with the admin setup wizard, when no certificate files are configured.
  await syncStoredCredentials(db, cfg);
  const svc: Services = {
    cfg,
    db,
    sessions: new Sessions(cfg.secret, cfg.publicUrl.startsWith('https://')),
    mailer: opts.mailer ?? createMailer(cfg, log),
    sms: opts.sms ?? createSms(cfg, log),
    notifier: new Notifier(db, cfg, log),
    googleKeys: opts.googleKeys ?? defaultGoogleKeys(),
    log,
  };
  app.decorate('svc', svc);
  app.addHook('onClose', async () => svc.notifier.close());

  await app.register(cookie);
  // A generous per-visitor ceiling on every route; sign-in and code routes set much tighter ones.
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    allowList: (req) => !cfg.isProd && (req.ip === '127.0.0.1' || req.ip === '::1'),
  });

  const https = cfg.publicUrl.startsWith('https://');
  const csp = [
    "default-src 'self'",
    // Google's sign-in button is the only outside script, frame and style the site loads.
    "script-src 'self' https://accounts.google.com/gsi/client",
    // React sets some styles inline (colours from the program settings).
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
    "frame-src https://accounts.google.com/gsi/",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://accounts.google.com/gsi/",
    "media-src 'self' blob:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', csp);
    // Google's sign-in pop-up must be able to answer the page that opened it.
    reply.header('cross-origin-opener-policy', 'same-origin-allow-popups');
    reply.header('cross-origin-resource-policy', 'same-site');
    // The staff counter needs the camera; nothing needs the microphone, location or payments.
    reply.header('permissions-policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    if (https) reply.header('strict-transport-security', 'max-age=31536000');
    // Keep sign-in and admin screens out of Google.
    if (/^\/(admin|staff|me|api)(\/|$|\?)/.test(req.url)) reply.header('x-robots-tag', 'noindex, nofollow');
    // Personal data must never sit in Cloudflare's or a browser's cache.
    if (req.url.startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });

  // Cross-site request forgery guard: a browser on another website must not be able to make a
  // signed-in member's or staff member's browser change anything here. Browsers always send
  // Origin (or Sec-Fetch-Site) on such requests. Machine callers (POS, Apple Wallet) send neither.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/pos/') || req.url.startsWith('/api/wallet/apple/v1/')) return;
    const site = req.headers['sec-fetch-site'];
    const origin = req.headers.origin;
    let crossSite = site === 'cross-site' || site === 'same-site';
    if (!crossSite && origin && origin !== 'null') {
      try {
        const o = new URL(origin);
        crossSite = o.host !== req.headers.host && o.origin !== new URL(cfg.publicUrl).origin;
      } catch {
        crossSite = true;
      }
    } else if (origin === 'null') {
      crossSite = true;
    }
    if (crossSite) {
      req.log.warn({ origin, site }, 'blocked cross-site request');
      return reply.status(403).send({ error: 'This request came from another website and was blocked.' });
    }
  });

  // Activity log of changes made in the admin area (who, what, when, from where). Values are not
  // stored, only which settings changed, so passwords and member details stay out of the log.
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? '';
    if (!route.startsWith('/api/admin/') || reply.statusCode >= 400 || !req.staffSession) return;
    const exported = route.endsWith('.csv');
    if (req.method === 'GET' && !exported) return;
    const params = (req.params ?? {}) as Record<string, string>;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? Object.keys(req.body as object) : [];
    await audit(
      db,
      req,
      {
        staffId: req.staffSession.id,
        action: exported ? `export ${route.slice('/api/admin/'.length)}` : `${req.method} ${route.slice('/api/admin/'.length)}`,
        target: params.id ?? params.code ?? null,
        details: body.length ? { fields: body.filter((k) => k !== 'password') } : null,
      },
      log,
    );
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
  await app.register(securityRoutes, { prefix: '/api/staff/security' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(posRoutes, { prefix: '/api/pos/v1' });

  // Serve the built web app (customer, staff and admin SPA) with client-side routing fallback.
  const webDist = resolve(cfg.webDist);
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      // Built scripts and styles have a content hash in their name, so browsers and Cloudflare may
      // keep them for a year; the page itself and the service worker are always re-checked so an
      // update shows up straight away.
      setHeaders: (reply, path) => void reply.header('cache-control', staticCacheControl(path)),
    });
    app.setNotFoundHandler((req, reply) => {
      if ((req.method === 'GET' || req.method === 'HEAD') && !req.url.startsWith('/api/')) {
        return reply.type('text/html').header('cache-control', 'no-cache').sendFile('index.html');
      }
      return reply.status(404).send({ error: 'Not found' });
    });
  }

  return app;
}

export function staticCacheControl(path: string): string {
  const p = path.replace(/\\/g, '/');
  if (/\/assets\/[^/]+-[\w-]{8,}\.(js|css|woff2?|png|svg|jpg|webp)$/.test(p)) return 'public, max-age=31536000, immutable';
  if (/\/(index\.html|sw\.js|manifest\.webmanifest)$/.test(p)) return 'no-cache';
  return 'public, max-age=86400';
}
