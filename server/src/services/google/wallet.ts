import { createSign } from 'node:crypto';
import type { Config } from '../../config.js';
import type { PassData, Program } from '../program.js';
import { memberCenterUrl } from '../apple/pass.js';

export type GoogleConfig = NonNullable<Config['google']>;
const API = 'https://walletobjects.googleapis.com/walletobjects/v1';

function b64url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url');
}

function signJwt(payload: object, privateKey: string): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${signer.sign(privateKey).toString('base64url')}`;
}

export class GoogleWallet {
  private token: { value: string; exp: number } | null = null;
  constructor(private g: GoogleConfig, private publicUrl: string, private log: (m: string) => void) {}

  objectId(serial: string) {
    return `${this.g.issuerId}.${serial.replace(/[^\w.-]/g, '_')}`;
  }

  loyaltyClass(program: Program) {
    return {
      id: this.g.classId,
      issuerName: program.brand_name,
      programName: program.name,
      programLogo: { sourceUri: { uri: `${this.publicUrl}/api/wallet/assets/logo-square.png` } },
      hexBackgroundColor: program.background_color,
      reviewStatus: 'UNDER_REVIEW',
      multipleDevicesAndHoldersAllowedStatus: 'ONE_USER_ALL_DEVICES',
    };
  }

  loyaltyObject(program: Program, data: PassData) {
    const { card, customer } = data;
    const obj: any = {
      id: this.objectId(card.serial_number),
      classId: this.g.classId,
      state: 'ACTIVE',
      accountId: card.serial_number,
      accountName: `${customer.first_name} ${customer.last_name}`.trim(),
      loyaltyPoints: { label: 'Stamps', balance: { string: `${card.stamps}/${program.stamps_required}` } },
      secondaryLoyaltyPoints: { label: 'Rewards', balance: { int: data.activeVouchers } },
      barcode: { type: 'QR_CODE', value: card.qr_token, alternateText: card.qr_token.slice(0, 8) },
      heroImage: {
        sourceUri: {
          uri: `${this.publicUrl}/api/wallet/assets/strip/${Math.min(card.stamps, program.stamps_required)}-${program.stamps_required}.png`,
        },
      },
      linksModuleData: {
        uris: [{ uri: memberCenterUrl(this.publicUrl, data), description: 'Member Center', id: 'member_center' }],
      },
      textModulesData: [
        ...(customer.tier ? [{ id: 'tier', header: 'Tier', body: customer.tier }] : []),
        { id: 'how', header: 'How it works', body: `Collect ${program.stamps_required} stamps to earn a reward.` },
      ],
      locations: data.stores.map((s) => ({ latitude: s.latitude, longitude: s.longitude })),
    };
    return obj;
  }

  /** "Add to Google Wallet" link. Embeds the class and object so no pre-creation is needed. */
  saveUrl(program: Program, data: PassData): string {
    const jwt = signJwt(
      {
        iss: this.g.clientEmail,
        aud: 'google',
        typ: 'savetowallet',
        origins: [this.publicUrl],
        payload: { loyaltyClasses: [this.loyaltyClass(program)], loyaltyObjects: [this.loyaltyObject(program, data)] },
      },
      this.g.privateKey,
    );
    return `https://pay.google.com/gp/v/save/${jwt}`;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const assertion = signJwt(
      {
        iss: this.g.clientEmail,
        scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      },
      this.g.privateKey,
    );
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`google token ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.accessToken();
    return fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      // A slow Google never holds up a stamp or a campaign for long.
      signal: AbortSignal.timeout(10_000),
    });
  }

  /** Creates or updates the class (run from admin settings after branding changes). */
  async upsertClass(program: Program): Promise<void> {
    const cls = this.loyaltyClass(program);
    const res = await this.call('PUT', `/loyaltyClass/${cls.id}`, cls);
    if (res.status === 404) {
      const created = await this.call('POST', '/loyaltyClass', cls);
      if (!created.ok) throw new Error(`google class create ${created.status}: ${await created.text()}`);
    } else if (!res.ok) {
      throw new Error(`google class update ${res.status}: ${await res.text()}`);
    }
  }

  /** Pushes new stamp counts to a saved Google pass. Optional message triggers a notification. */
  async updateObject(program: Program, data: PassData, message?: { header: string; body: string }): Promise<boolean> {
    const obj = this.loyaltyObject(program, data);
    const res = await this.call('PATCH', `/loyaltyObject/${obj.id}`, obj);
    if (res.status === 404) return false; // never saved by the customer
    if (!res.ok) {
      this.log(`google object update ${res.status}: ${await res.text()}`);
      return false;
    }
    if (message) {
      const m = await this.call('POST', `/loyaltyObject/${obj.id}/addMessage`, {
        message: {
          id: `m${Date.now()}`,
          header: message.header,
          body: message.body,
          messageType: 'TEXT_AND_NOTIFY',
        },
      });
      if (!m.ok) this.log(`google addMessage ${m.status}: ${await m.text()}`);
    }
    return true;
  }
}
