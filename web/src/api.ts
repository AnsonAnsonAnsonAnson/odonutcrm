export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public issues?: { path: string; message: string }[]) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.code, data?.issues);
  }
  return data as T;
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export interface PublicConfig {
  brandName: string;
  programName: string;
  stampsRequired: number;
  /** Bill amount per stamp; 0 when staff count stamps by hand. */
  spendPerStamp: number;
  signupStamps: number;
  rewardSummary: string;
  welcomeGift: string | null;
  /** Google sign-in OAuth client ID; null hides the Google button. */
  googleClientId: string | null;
  /** New members confirm their mobile number with a text code. */
  verifyPhone: boolean;
  backgroundColor: string;
  foregroundColor: string;
  labelColor: string;
  terms: string;
  appleWallet: boolean;
  googleWallet: boolean;
  vapidPublicKey: string | null;
  privacyPolicy: string;
  smsSignIn: boolean;
  stampPromo: { multiplier: number; label: string; endsAt: string | null } | null;
}

export const platform = (() => {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  return { ios, android, mobile: ios || android };
})();

export function fmtDate(d: string | Date | null | undefined, withTime = false) {
  if (!d) return '';
  const dt = new Date(d);
  const date = dt.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-');
  return withTime ? `${date} ${dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : date;
}

export function newKey() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

/** Hong Kong dollars as shop staff write them: $85, $1,240, $42.50. */
export function fmtMoney(n: number | string | null | undefined) {
  const v = Number(n ?? 0);
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** "3 days ago", "2 months ago": how long since a date, for quick reading in the CRM. */
export function fmtAgo(d: string | Date | null | undefined) {
  if (!d) return '';
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? '1 month ago' : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}
