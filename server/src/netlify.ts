/**
 * Netlify Functions entry points. The same Fastify app runs inside a function instead of a
 * long-running server: web requests go through `handleRequest`, and the minute-by-minute jobs
 * (scheduled campaigns, daily birthday / win-back / nudge runs) through `runScheduledJobs`.
 * See docs/07-netlify-test.md for what this setup can and cannot do.
 */
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config.js';
import { createPool, migrate, type Db } from './db.js';
import { buildApp } from './app.js';
import { seed } from './seed.js';
import { tick } from './services/jobs.js';

interface Runtime {
  cfg: Config;
  db: Db;
  app: FastifyInstance;
}

let booting: Promise<Runtime> | null = null;

/** One app per function instance, created on the first request and reused while the instance stays warm. */
function runtime(): Promise<Runtime> {
  booting ??= (async () => {
    // Files the bundler copies next to the function (see included_files in netlify.toml).
    const root = process.env.LAMBDA_TASK_ROOT ?? process.cwd();
    process.env.MIGRATIONS_DIR ??= join(root, 'server', 'migrations');
    process.env.PASS_ASSET_DIR ??= join(root, 'server', 'assets', 'pass');
    // APP_ENV decides test vs production on Netlify, so a missing SMTP setup logs sign-in codes instead of dropping them.
    const cfg = loadConfig({ ...process.env, NODE_ENV: process.env.APP_ENV || 'development', NETLIFY: 'true', RUN_JOBS: 'false', WEB_DIST: '/nonexistent' });
    // Serverless instances come and go; keep each one's share of database connections small.
    const db = createPool(cfg.databaseUrl, 3);
    await migrate(db, () => {});
    await seed(db, { adminEmail: cfg.adminEmail, adminPassword: cfg.adminPassword, log: () => {} });
    // Logs go to Netlify's function log, which is also where test-mode sign-in codes appear.
    const app = await buildApp(cfg, db);
    await app.ready();
    return { cfg, db, app };
  })().catch((err) => {
    booting = null;
    throw err;
  });
  return booting;
}

export async function handleRequest(req: Request): Promise<Response> {
  let rt: Runtime;
  try {
    rt = await runtime();
  } catch (err: any) {
    console.error(err);
    return Response.json(
      { error: 'The server could not start. Check the Netlify function log; usually the database or APP_SECRET is not set up yet.' },
      { status: 503 },
    );
  }
  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer());
  const res = await rt.app.inject({
    method: req.method as any,
    url: url.pathname + url.search,
    headers,
    payload: body,
    remoteAddress: headers['x-nf-client-connection-ip'] ?? headers['x-forwarded-for']?.split(',')[0]?.trim(),
  });
  const out = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined || k === 'content-length' || k === 'transfer-encoding' || k === 'connection') continue;
    for (const one of Array.isArray(v) ? v : [String(v)]) out.append(k, String(one));
  }
  const noBody = res.statusCode === 204 || res.statusCode === 304 || req.method === 'HEAD';
  return new Response(noBody ? null : new Uint8Array(res.rawPayload), { status: res.statusCode, headers: out });
}

export async function runScheduledJobs(): Promise<void> {
  const { cfg, db, app } = await runtime();
  await tick(db, cfg, app.svc.notifier, (m) => console.log(m));
}
