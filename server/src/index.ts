import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { buildApp } from './app.js';
import { seed } from './seed.js';
import { startJobs } from './services/jobs.js';

const cfg = loadConfig();
const db = createPool(cfg.databaseUrl);
await migrate(db);
await seed(db, { adminEmail: cfg.adminEmail, adminPassword: cfg.adminPassword });

const app = await buildApp(cfg, db);
const log = (m: string) => app.log.info(m);
log(
  `integrations: apple=${!!cfg.apple} google=${!!cfg.google} webpush=${!!cfg.vapid} smtp=${!!cfg.smtp} publicUrl=${cfg.publicUrl}`,
);
const stopJobs = cfg.runJobs ? startJobs(db, cfg, app.svc.notifier, log) : () => {};

// Background work (wallet refreshes, emails) that fails must be logged, not take the whole site down.
process.on('unhandledRejection', (err: any) => app.log.error({ err }, 'unhandled background error'));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stopJobs();
    await app.close();
    await db.end();
    process.exit(0);
  });
}

await app.listen({ port: cfg.port, host: cfg.host });
