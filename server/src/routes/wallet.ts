import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../lib/auth.js';
import { buildPkpass } from '../services/apple/pass.js';
import { renderIcon, renderStrip } from '../services/apple/images.js';
import { getProgram, loadPassData } from '../services/program.js';

export async function walletRoutes(app: FastifyInstance) {
  const { db, cfg, sessions, notifier } = app.svc;

  // Customer downloads their personal .pkpass (Safari offers "Add to Apple Wallet").
  app.get('/apple/pass', async (req, reply) => {
    const s = await sessions.customer(req);
    if (!s) throw new HttpError(401, 'Please sign in');
    if (!cfg.apple) throw new HttpError(503, 'Apple Wallet is not set up yet');
    const data = await loadPassData(db, { customerId: s.id });
    if (!data) throw new HttpError(404, 'Card not found');
    const pkpass = await buildPkpass(cfg.apple, cfg.publicUrl, await getProgram(db), data);
    return reply
      .header('content-type', 'application/vnd.apple.pkpass')
      .header('content-disposition', `attachment; filename="${data.card.serial_number}.pkpass"`)
      .header('last-modified', data.card.updated_at.toUTCString())
      .header('cache-control', 'no-store')
      .send(pkpass);
  });

  app.get('/google/save', async (req, reply) => {
    const s = await sessions.customer(req);
    if (!s) throw new HttpError(401, 'Please sign in');
    if (!notifier.google) throw new HttpError(503, 'Google Wallet is not set up yet');
    const data = await loadPassData(db, { customerId: s.id });
    if (!data) throw new HttpError(404, 'Card not found');
    // Optimistic: later updates to a pass the customer never saved simply return 404 and are ignored.
    await db.query('UPDATE cards SET google_saved = true WHERE id = $1', [data.card.id]);
    return reply.redirect(notifier.google.saveUrl(await getProgram(db), data));
  });

  // Public images Google Wallet fetches (stamp strip and logo).
  app.get('/assets/strip/:file', async (req, reply) => {
    const { file } = z.object({ file: z.string().regex(/^\d{1,2}-\d{1,2}\.png$/) }).parse(req.params);
    const [stamps, required] = file.replace('.png', '').split('-').map(Number);
    if (required < 2 || required > 20 || stamps > required) throw new HttpError(404, 'Not found');
    const p = await getProgram(db);
    const png = await renderStrip({ stamps, required, background: p.background_color, icing: '#F2709E', scale: 3 });
    return reply.header('content-type', 'image/png').header('cache-control', 'public, max-age=86400').send(png);
  });

  app.get('/assets/logo-square.png', async (_req, reply) => {
    const png = await renderIcon(660, '#F2709E');
    return reply.header('content-type', 'image/png').header('cache-control', 'public, max-age=86400').send(png);
  });
}
