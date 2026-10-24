import { createHash } from 'node:crypto';
import { one, type Queryable } from '../db.js';

// One member per person: the same mobile number can't join twice, and the welcome gift is
// given once per mobile number and per email, even if the member deletes their account and
// joins again. Matches od_email_key() and the fingerprints in migration 008.

/** The inbox an address really reaches: Gmail ignores dots and anything after "+". */
export function emailKey(email: string) {
  const [local = '', domain = ''] = email.trim().toLowerCase().split('@');
  const base = local.replace(/\+.*$/, '');
  return domain === 'gmail.com' || domain === 'googlemail.com' ? `${base.replace(/\./g, '')}@gmail.com` : `${base}@${domain}`;
}

/** +852 6123 4567 -> 85261234567 */
export const phoneKey = (phone: string) => phone.replace(/\D/g, '');

const fingerprint = (kind: 'email' | 'phone', value: string) => createHash('sha256').update(`${kind}:${value}`).digest('hex');

const fingerprints = (email: string, phone: string | null | undefined) => [
  fingerprint('email', emailKey(email)),
  ...(phone && phoneKey(phone) ? [fingerprint('phone', phoneKey(phone))] : []),
];

export async function welcomeAlreadyClaimed(q: Queryable, email: string, phone: string | null | undefined) {
  return !!(await one(q, 'SELECT 1 FROM welcome_claims WHERE key_hash = ANY($1)', [fingerprints(email, phone)]));
}

export async function recordWelcomeClaim(q: Queryable, email: string, phone: string | null | undefined) {
  await q.query('INSERT INTO welcome_claims (key_hash) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING', [fingerprints(email, phone)]);
}

/** The member already using this mobile number, if any (other than `exceptId`). */
export async function phoneOwner(q: Queryable, phone: string, exceptId: string | null = null) {
  const key = phoneKey(phone);
  if (!key) return null;
  return one<{ id: string }>(q, 'SELECT id FROM customers WHERE phone_key = $1 AND id IS DISTINCT FROM $2 LIMIT 1', [key, exceptId]);
}
