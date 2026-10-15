import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Return DATE columns as plain 'YYYY-MM-DD' strings rather than local-midnight Date objects.
pg.types.setTypeParser(1082, (v) => v);
// Return bigint counts as numbers (our counts stay far below 2^53).
pg.types.setTypeParser(20, (v) => Number(v));
// Return numeric as number.
pg.types.setTypeParser(1700, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T = any>(q: Queryable, text: string, params: unknown[] = []): Promise<T | null> {
  const r = await q.query(text, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = any>(q: Queryable, text: string, params: unknown[] = []): Promise<T[]> {
  const r = await q.query(text, params);
  return r.rows as T[];
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(db: Db, log: (m: string) => void = console.log): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await many<{ name: string }>(db, 'SELECT name FROM schema_migrations')).map((r) => r.name));
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(migrationsDir, f), 'utf8');
    await withTx(db, async (tx) => {
      // Serialise concurrent migrators (e.g. two containers booting at once).
      await tx.query('SELECT pg_advisory_xact_lock(424242)');
      const again = await one(tx, 'SELECT 1 FROM schema_migrations WHERE name = $1', [f]);
      if (again) return;
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    log(`migration applied: ${f}`);
  }
}
