import sharp from 'sharp';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Brand art lives in server/assets/pass. Drop in your own icon.png / logo.png / stamp-on.png /
// stamp-off.png (any size, square for stamps) and they replace the generated defaults.
// PASS_ASSET_DIR overrides it where the code runs bundled (e.g. Netlify Functions).
const assetDir = () => process.env.PASS_ASSET_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'assets', 'pass');

const assetCache = new Map<string, { mtime: number; buf: Buffer }>();

// Read once and kept in memory; a replaced file (newer modified time) is picked up on the next pass.
function asset(name: string): Buffer | null {
  const p = join(assetDir(), name);
  let mtime: number;
  try {
    mtime = statSync(p).mtimeMs;
  } catch {
    assetCache.delete(p);
    return null;
  }
  const hit = assetCache.get(p);
  if (hit && hit.mtime === mtime) return hit.buf;
  const buf = readFileSync(p);
  assetCache.set(p, { mtime, buf });
  return buf;
}

/** Rendered images are small and few, so each one is drawn once and reused for every pass. */
const imageCache = new Map<string, Promise<Buffer>>();
function cached(key: string, render: () => Promise<Buffer>): Promise<Buffer> {
  const k = `${key}|${['icon.png', 'logo.png', 'stamp-on.png', 'stamp-off.png'].map((n) => assetCache.get(join(assetDir(), n))?.mtime ?? 0).join(',')}`;
  let hit = imageCache.get(k);
  if (!hit) {
    if (imageCache.size > 100) imageCache.clear();
    hit = render();
    imageCache.set(k, hit);
    hit.catch(() => imageCache.delete(k));
  }
  return hit;
}

// Same look as the member site: a donut with a real hole so the card colour shows through, and a
// faint dashed ring for stamps still to collect (visible on dark and light card colours).
function donutSvg(size: number, filled: boolean, icing: string): string {
  const c = size / 2;
  const ring = (R: number, r: number) =>
    `M${c} ${c - R}a${R} ${R} 0 1 1 0 ${2 * R}a${R} ${R} 0 1 1 0 ${-2 * R}zM${c} ${c - r}a${r} ${r} 0 1 0 0 ${2 * r}a${r} ${r} 0 1 0 0 ${-2 * r}z`;
  if (!filled) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <path d="${ring(size * 0.45, size * 0.14)}" fill="none" stroke="#9CA3AF" stroke-opacity="0.6" stroke-width="${size * 0.025}" stroke-dasharray="${size * 0.05} ${size * 0.05}"/>
  </svg>`;
  }
  const sprinkles = [
    [-0.18, -0.22, 25], [0.15, -0.25, -35], [0.25, 0.08, 65], [-0.03, 0.25, 10], [-0.26, 0.07, -55],
  ]
    .map(([dx, dy, rot]) => {
      const x = c + dx * size;
      const y = c + dy * size;
      return `<rect x="${x - size * 0.045}" y="${y - size * 0.015}" width="${size * 0.09}" height="${size * 0.03}" rx="${size * 0.015}" fill="#FFFFFF" opacity="0.9" transform="rotate(${rot} ${x} ${y})"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <path d="${ring(size * 0.46, size * 0.14)}" fill="#E8B46C" fill-rule="evenodd"/>
    <path d="${ring(size * 0.39, size * 0.17)}" fill="${icing}" fill-rule="evenodd"/>
    ${sprinkles}
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
  // Includes the custom stamp art's version, so replaced art shows without a restart.
  const art = ['stamp-on.png', 'stamp-off.png'].map((n) => (asset(n) ? assetCache.get(join(assetDir(), n))!.mtime : 0));
  const key = JSON.stringify(opts) + art.join(',');
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

export function renderLogo(scale: 1 | 2 | 3, brandName: string, color: string): Promise<Buffer> {
  const custom = asset('logo.png');
  return cached(`logo|${scale}|${brandName}|${color}|${!!custom}`, () => drawLogo(scale, brandName, color, custom));
}

async function drawLogo(scale: 1 | 2 | 3, brandName: string, color: string, custom: Buffer | null): Promise<Buffer> {
  const w = 160 * scale;
  const h = 50 * scale;
  if (custom) return sharp(custom).resize(w, h, { fit: 'inside' }).png().toBuffer();
  return sharp(Buffer.from(logoSvg(w, h, brandName, color))).png().toBuffer();
}

export function renderIcon(size: number, icing: string): Promise<Buffer> {
  const custom = asset('icon.png');
  return cached(`icon|${size}|${icing}|${!!custom}`, () => drawIcon(size, icing, custom));
}

async function drawIcon(size: number, icing: string, custom: Buffer | null): Promise<Buffer> {
  if (custom) return sharp(custom).resize(size, size, { fit: 'cover' }).png().toBuffer();
  return sharp(Buffer.from(donutSvg(size, true, icing))).png().toBuffer();
}
