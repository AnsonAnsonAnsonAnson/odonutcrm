import { createPool, migrate } from '../db.js';
const db = createPool(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/odonut');
await migrate(db);
await db.end();
