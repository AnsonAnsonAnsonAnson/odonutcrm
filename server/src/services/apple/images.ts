import sharp from 'sharp';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Brand art lives in server/assets/pass. Drop in your own icon.png / logo.png / stamp-on.png /
// stamp-off.png (any size, square for stamps) and they replace the generated defaults.
// PASS_ASSET_DIR overrides it where the code runs bundled (e.g. Netlify Functions).
const assetDir = () => process.env.PASS_ASSET_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'assets', 'pass');

function asset(name: string): Buffer | null {
  const p = join(assetDir(), name);
  return existsSync(p) ? readFileSync(p) : null;
}

function donutSvg(size: number, filled: boolean, icing: string): string {
  const c = size / 2;
  const dough = filled ? '#E3A869' : '#D4D4D4';
  const ice = filled ? icing : '#BDBDBD';
  const sprinkleColors = filled ? ['#FFFFFF', '#FFD23F', '#3BCEAC', '#5B3A29'] : ['#E8E8E8'];
  const sprinkles = [
    [-0.24, -0.18, 20], [0.2, -0.25, -30], [0.27, 0.1, 60], [-0.05, 0.3, 10],
    [-0.3, 0.12, -50], [0.05, -0.33, 80], [0.18, 0.26, -15],
  ]
    .map(([dx, dy, rot], i) => {
      const x = c + dx * size;
      const y = c + dy * size;
      const col = sprinkleColors[i % sprinkleColors.length];
      return `<rect x="${x - size * 0.04}" y="${y - size * 0.012}" width="${size * 0.08}" height="${size * 0.024}" rx="${size * 0.012}" fill="${col}" transform="rotate(${rot} ${x} ${y})"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${c}" cy="${c}" r="${size * 0.48}" fill="#FFFFFF"/>
    <circle cx="${c}" cy="${c}" r="${size * 0.4}" fill="${dough}"/>
    <path d="M ${c} ${c - size * 0.36} a ${size * 0.36} ${size * 0.36} 0 1 1 -0.01 0 z" fill="${ice}"/>
    ${sprinkles}
    <circle cx="${c}" cy="${c}" r="${size * 0.12}" fill="#FFFFFF"/>
  </svg>`;
}

async function stampTile(size: number, filled: boolean, icing: string): Promise<Buffer> {
  const custom = asset(filled ? 'stamp-on.png' : 'stamp-off.png');
  if (custom) {
    const circle = Buffer.from(
      `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
    );
    const inner = await sharp(custom).resize(Math.round(size * 0.78), Math.round(size * 0.78), { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    return sharp(circle).composite([{ input: inner, gravity: 'center' }]).png().toBuffer();
  }
  return sharp(Buffer.from(donutSvg(size, filled, icing))).png().toBuffer();
}

const stripCache = new Map<string, Buffer>();

/**
 * Renders the stamp strip shown on the pass, e.g. 3 of 10 filled.
 * scale 1 = 375x144 points (Apple storeCard strip), scale 2/3 for retina.
 */
export async function renderStrip(opts: {
  stamps: number;
  required: number;
  background: string;
  icing: string;
  scale: 1 | 2 | 3;
}): Promise<Buffer> {
  const key = JSON.stringify(opts);
  const hit = stripCache.get(key);
  if (hit) return hit;
  const W = 375 * opts.scale;
  const H = 144 * opts.scale;
  const rows = opts.required <= 5 ? 1 : 2;
  const cols = Math.ceil(opts.required / rows);
  const gap = 10 * opts.scale;
  const tile = Math.floor(Math.min((W - gap * (cols + 1)) / cols, (H - gap * (rows + 1)) / rows));
  const totalW = cols * tile + (cols - 1) * gap;
  const totalH = rows * tile + (rows - 1) * gap;
  const x0 = Math.round((W - totalW) / 2);
  const y0 = Math.round((H - totalH) / 2);

  const [on, off] = await Promise.all([stampTile(tile, true, opts.icing), stampTile(tile, false, opts.icing)]);
  const composites = [];
  for (let i = 0; i < opts.required; i++) {
    const r = Math.floor(i / cols);
    const col = i % cols;
    composites.push({ input: i < opts.stamps ? on : off, left: x0 + col * (tile + gap), top: y0 + r * (tile + gap) });
  }
  const buf = await sharp({ create: { width: W, height: H, channels: 4, background: opts.background } })
    .composite(composites)
    .png()
    .toBuffer();
  if (stripCache.size > 200) stripCache.clear();
  stripCache.set(key, buf);
  return buf;
}

function logoSvg(w: number, h: number, text: string, color: string): string {
  const fs = Math.round(h * 0.56);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <text x="0" y="${Math.round(h * 0.7)}" font-family="Arial Rounded MT Bold, Helvetica, Arial, sans-serif" font-weight="800" font-size="${fs}" fill="${color}">${escapeXml(text)}</text>
  </svg>`;
}

function escapeXml(s: string) {
  return s.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch]!);
}

export async function renderLogo(scale: 1 | 2 | 3, brandName: string, color: string): Promise<Buffer> {
  const custom = asset('logo.png');
  const w = 160 * scale;
  const h = 50 * scale;
  if (custom) return sharp(custom).resize(w, h, { fit: 'inside' }).png().toBuffer();
  return sharp(Buffer.from(logoSvg(w, h, brandName, color))).png().toBuffer();
}

export async function renderIcon(size: number, icing: string): Promise<Buffer> {
  const custom = asset('icon.png');
  if (custom) return sharp(custom).resize(size, size, { fit: 'cover' }).png().toBuffer();
  return sharp(Buffer.from(donutSvg(size, true, icing))).png().toBuffer();
}
