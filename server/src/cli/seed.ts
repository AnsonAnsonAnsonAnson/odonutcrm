import { createPool, migrate } from '../db.js';
import { seed } from '../seed.js';
const db = createPool(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/odonut');
await migrate(db);
await seed(db, { adminEmail: process.env.ADMIN_EMAIL, adminPassword: process.env.ADMIN_PASSWORD });
await db.end();
