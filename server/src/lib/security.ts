import type { FastifyRequest } from 'fastify';
import type { Queryable } from '../db.js';

// Passwords people pick first, plus shop-specific guesses. Checked after lower-casing and
// stripping digits and symbols from the ends, so "Password123!" and "odonut2026" are caught too.
const COMMON = new Set([
  'password', 'passw0rd', 'qwerty', 'qwertyuiop', 'asdfghjkl', 'iloveyou', 'welcome', 'letmein', 'admin',
  'administrator', 'abc', 'abcdef', 'abcdefgh', 'monkey', 'dragon', 'football', 'baseball', 'sunshine',
  'princess', 'starwars', 'whatever', 'trustno', 'changeme', 'secret', 'hongkong', 'donut', 'donuts',
  'odonut', 'odonutclub', 'loyalty', 'staff', 'manager', 'owner', 'shop', 'store', 'cashier',
]);

/** Returns a reason the password is too weak, or null. */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < 10) return 'Use at least 10 characters';
  if (password.length > 200) return 'Use at most 200 characters';
  const core = password.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');
  if (COMMON.has(core) || /^(\d+|(.)\2+)$/.test(password) || /^(0123456789|1234567890|9876543210)/.test(password)) {
    return 'That password is too easy to guess. Try three or four unrelated words.';
  }
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) return "Don't use your email in your password";
  if (new Set(password).size < 5) return 'Use a mix of more different characters';
  return null;
}

export interface AuditEntry {
  staffId?: string | null;
  actor?: string | null;
  action: string;
  target?: string | null;
  details?: Record<string, unknown> | null;
}

/** Writes one line to the activity log. Never fails the request it belongs to. */
export async function audit(db: Queryable, req: FastifyRequest | null, e: AuditEntry, log?: (m: string) => void): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_log (staff_id, actor, action, target, ip, user_agent, details) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        e.staffId ?? null,
        e.actor ?? null,
        e.action,
        e.target ?? null,
        req?.ip ?? null,
        req ? String(req.headers['user-agent'] ?? '').slice(0, 300) : null,
        e.details ? JSON.stringify(e.details) : null,
      ],
    );
  } catch (err: any) {
    log?.(`audit log write failed: ${err.message}`);
  }
}
