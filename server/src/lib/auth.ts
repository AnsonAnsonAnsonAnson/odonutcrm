import { SignJWT, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const CUSTOMER_COOKIE = 'od_c';
export const STAFF_COOKIE = 'od_s';

export type StaffRole = 'owner' | 'manager' | 'staff';
export interface StaffSession { id: string; role: StaffRole; storeId: string | null; name: string }
export interface CustomerSession { id: string }

const ROLE_RANK: Record<StaffRole, number> = { staff: 1, manager: 2, owner: 3 };

export class Sessions {
  private key: Uint8Array;
  constructor(secret: string, private secure: boolean) {
    this.key = new TextEncoder().encode(secret);
  }

  async sign(payload: Record<string, unknown>, audience: string, ttl: string): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(ttl)
      .sign(this.key);
  }

  async verify<T>(token: string | undefined, audience: string): Promise<T | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, { audience });
      return payload as T;
    } catch {
      return null;
    }
  }

  cookieOptions(maxAgeSeconds: number) {
    return { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: this.secure, maxAge: maxAgeSeconds };
  }

  async setCustomer(reply: FastifyReply, customerId: string) {
    const token = await this.sign({ sub: customerId }, 'customer', '180d');
    reply.setCookie(CUSTOMER_COOKIE, token, this.cookieOptions(180 * 24 * 3600));
  }

  async setStaff(reply: FastifyReply, s: StaffSession) {
    const token = await this.sign({ sub: s.id, role: s.role, storeId: s.storeId, name: s.name }, 'staff', '12h');
    reply.setCookie(STAFF_COOKIE, token, this.cookieOptions(12 * 3600));
  }

  async customer(req: FastifyRequest): Promise<CustomerSession | null> {
    const p = await this.verify<{ sub: string }>(req.cookies[CUSTOMER_COOKIE], 'customer');
    return p ? { id: p.sub } : null;
  }

  async staff(req: FastifyRequest): Promise<StaffSession | null> {
    const p = await this.verify<{ sub: string; role: StaffRole; storeId: string | null; name: string }>(
      req.cookies[STAFF_COOKIE],
      'staff',
    );
    return p ? { id: p.sub, role: p.role, storeId: p.storeId, name: p.name } : null;
  }

  // Short-lived single-purpose link token (desktop -> phone hand-off).
  async handoffToken(customerId: string): Promise<string> {
    return this.sign({ sub: customerId }, 'handoff', '15m');
  }
  async verifyHandoff(token: string): Promise<string | null> {
    const p = await this.verify<{ sub: string }>(token, 'handoff');
    return p?.sub ?? null;
  }
}

export function hasRole(session: StaffSession, min: StaffRole): boolean {
  return ROLE_RANK[session.role] >= ROLE_RANK[min];
}

export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public code?: string) {
    super(message);
  }
}
