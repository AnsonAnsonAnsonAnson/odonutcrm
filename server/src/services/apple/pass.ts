import { PKPass } from 'passkit-generator';
import type { Config } from '../../config.js';
import type { PassData, Program } from '../program.js';
import { renderIcon, renderLogo, renderStrip } from './images.js';

export type AppleConfig = NonNullable<Config['apple']>;

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

export function memberCenterUrl(publicUrl: string, data: PassData): string {
  return `${publicUrl}/api/auth/card-login?s=${encodeURIComponent(data.card.serial_number)}&t=${encodeURIComponent(data.card.auth_token)}`;
}

/** The pass.json body. Exported separately so it can be unit-tested without certificates. */
export function passJson(cfg: { publicUrl: string; passTypeId: string; teamId: string }, program: Program, data: PassData) {
  const { card, customer } = data;
  const name = `${customer.first_name} ${customer.last_name}`.trim();
  const backFields: any[] = [];
  if (card.message) {
    backFields.push({
      key: 'news',
      label: 'Latest from ' + program.brand_name,
      value: card.message,
      // Changing this value makes iOS show the text on the lock screen.
      changeMessage: '%@',
    });
  }
  backFields.push(
    {
      key: 'member_center',
      label: 'Member Center',
      value: memberCenterUrl(cfg.publicUrl, data),
      attributedValue: `<a href="${memberCenterUrl(cfg.publicUrl, data)}">Open your vouchers & history</a>`,
    },
    {
      key: 'how',
      label: 'How it works',
      value: `Show this card at the counter to collect a stamp with every purchase. Collect ${program.stamps_required} stamps to earn a reward.`,
    },
    { key: 'terms', label: 'Terms', value: program.terms },
  );

  const json: any = {
    formatVersion: 1,
    passTypeIdentifier: cfg.passTypeId,
    teamIdentifier: cfg.teamId,
    serialNumber: card.serial_number,
    organizationName: program.brand_name,
    description: program.name,
    backgroundColor: hexToRgb(program.background_color),
    foregroundColor: hexToRgb(program.foreground_color),
    labelColor: hexToRgb(program.label_color),
    sharingProhibited: true,
    storeCard: {
      headerFields: [
        ...(customer.tier
          ? [{ key: 'tier', label: 'TIER', value: customer.tier, changeMessage: 'You are now %@!', textAlignment: 'PKTextAlignmentRight' }]
          : []),
        {
          key: 'stamps',
          label: 'STAMPS',
          value: `${card.stamps}/${program.stamps_required}`,
          changeMessage: 'You now have %@ stamps',
          textAlignment: 'PKTextAlignmentRight',
        },
      ],
      secondaryFields: [
        { key: 'member', label: 'MEMBER NAME', value: name || 'Member' },
        {
          key: 'rewards',
          label: 'REWARDS',
          value: data.activeVouchers,
          changeMessage: 'You have %@ reward(s) waiting',
          textAlignment: 'PKTextAlignmentCenter',
        },
        {
          key: 'updated',
          label: 'LAST UPDATE',
          value: card.updated_at.toISOString(),
          dateStyle: 'PKDateStyleShort',
          timeStyle: 'PKDateStyleShort',
          textAlignment: 'PKTextAlignmentRight',
        },
      ],
      backFields,
    },
    barcodes: [
      {
        format: 'PKBarcodeFormatQR',
        message: card.qr_token,
        messageEncoding: 'iso-8859-1',
        altText: card.qr_token.slice(0, 8),
      },
    ],
  };
  if (cfg.publicUrl.startsWith('https://')) {
    // Apple only talks to https web services.
    json.webServiceURL = `${cfg.publicUrl}/api/wallet/apple`;
    json.authenticationToken = card.auth_token;
  }
  if (data.stores.length) {
    json.locations = data.stores.map((s) => ({
      latitude: s.latitude,
      longitude: s.longitude,
      relevantText: s.relevant_text || `${program.brand_name} is nearby. Show your card for a stamp!`,
    }));
  }
  return json;
}

export async function passImages(program: Program, stamps: number): Promise<Record<string, Buffer>> {
  const strip = (scale: 1 | 2 | 3) =>
    renderStrip({ stamps, required: program.stamps_required, background: program.background_color, icing: '#F25C8A', scale });
  const [s1, s2, s3, l1, l2, l3, i1, i2, i3] = await Promise.all([
    strip(1), strip(2), strip(3),
    renderLogo(1, program.brand_name, program.foreground_color),
    renderLogo(2, program.brand_name, program.foreground_color),
    renderLogo(3, program.brand_name, program.foreground_color),
    renderIcon(29, '#F25C8A'), renderIcon(58, '#F25C8A'), renderIcon(87, '#F25C8A'),
  ]);
  return {
    'strip.png': s1, 'strip@2x.png': s2, 'strip@3x.png': s3,
    'logo.png': l1, 'logo@2x.png': l2, 'logo@3x.png': l3,
    'icon.png': i1, 'icon@2x.png': i2, 'icon@3x.png': i3,
  };
}

export async function buildPkpass(apple: AppleConfig, publicUrl: string, program: Program, data: PassData): Promise<Buffer> {
  const json = passJson({ publicUrl, passTypeId: apple.passTypeId, teamId: apple.teamId }, program, data);
  const images = await passImages(program, Math.min(data.card.stamps, program.stamps_required));
  const pass = new PKPass(
    { 'pass.json': Buffer.from(JSON.stringify(json)), ...images },
    {
      wwdr: apple.wwdr,
      signerCert: apple.cert,
      signerKey: apple.key,
      signerKeyPassphrase: apple.keyPassphrase,
    },
  );
  return pass.getAsBuffer();
}
