import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { many, one } from '../db.js';
import { safeEqual } from '../lib/crypto.js';
import { buildPkpass } from '../services/apple/pass.js';
import { getProgram, loadPassData } from '../services/program.js';

/**
 * Apple Wallet web service (developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes).
 * Mounted at {PUBLIC_URL}/api/wallet/apple, which is the pass's webServiceURL.
 */
export async function appleWebServiceRoutes(app: FastifyInstance) {
  const { db, cfg, log } = app.svc;

  async function authorise(req: FastifyRequest, reply: FastifyReply, serial: string): Promise<boolean> {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('ApplePass ') ? header.slice(10) : '';
    const card = await one<{ auth_token: string }>(db, 'SELECT auth_token FROM cards WHERE serial_number = $1', [serial]);
    if (!card || !token || !safeEqual(card.auth_token, token)) {
      reply.status(401).send();
      return false;
    }
    return true;
  }

  const regParams = z.object({
    deviceLibraryIdentifier: z.string().max(200),
    passTypeIdentifier: z.string().max(200),
    serialNumber: z.string().max(64),
  });

  app.post('/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber', async (req, reply) => {
    const p = regParams.parse(req.params);
    if (!cfg.apple || p.passTypeIdentifier !== cfg.apple.passTypeId) return reply.status(404).send();
    if (!(await authorise(req, reply, p.serialNumber))) return;
    const { pushToken } = z.object({ pushToken: z.string().max(200) }).parse(req.body);
    await db.query(
      `INSERT INTO apple_devices (device_library_id, push_token) VALUES ($1,$2)
       ON CONFLICT (device_library_id) DO UPDATE SET push_token = $2, updated_at = now()`,
      [p.deviceLibraryIdentifier, pushToken],
    );
    const r = await db.query(
      `INSERT INTO apple_registrations (device_library_id, pass_type_id, serial_number) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [p.deviceLibraryIdentifier, p.passTypeIdentifier, p.serialNumber],
    );
    return reply.status(r.rowCount ? 201 : 200).send();
  });

  app.delete('/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber', async (req, reply) => {
    const p = regParams.parse(req.params);
    if (!(await authorise(req, reply, p.serialNumber))) return;
    await db.query(
      'DELETE FROM apple_registrations WHERE device_library_id = $1 AND pass_type_id = $2 AND serial_number = $3',
      [p.deviceLibraryIdentifier, p.passTypeIdentifier, p.serialNumber],
    );
    await db.query(
      'DELETE FROM apple_devices d WHERE device_library_id = $1 AND NOT EXISTS (SELECT 1 FROM apple_registrations r WHERE r.device_library_id = d.device_library_id)',
      [p.deviceLibraryIdentifier],
    );
    return reply.status(200).send();
  });

  // Which of this device's passes changed since the tag it last saw?
  app.get('/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier', async (req, reply) => {
    const p = z.object({ deviceLibraryIdentifier: z.string().max(200), passTypeIdentifier: z.string().max(200) }).parse(req.params);
    const { passesUpdatedSince } = z.object({ passesUpdatedSince: z.string().max(40).optional() }).parse(req.query);
    const since = passesUpdatedSince && /^\d+$/.test(passesUpdatedSince) ? new Date(Number(passesUpdatedSince)) : new Date(0);
    const rows = await many<{ serial_number: string; updated_at: Date }>(
      db,
      `SELECT c.serial_number, c.updated_at FROM apple_registrations r JOIN cards c ON c.serial_number = r.serial_number
        WHERE r.device_library_id = $1 AND r.pass_type_id = $2 AND date_trunc('milliseconds', c.updated_at) > $3`,
      [p.deviceLibraryIdentifier, p.passTypeIdentifier, since],
    );
    if (!rows.length) return reply.status(204).send();
    const last = Math.max(...rows.map((r) => r.updated_at.getTime()));
    return { serialNumbers: rows.map((r) => r.serial_number), lastUpdated: String(last) };
  });

  app.get('/v1/passes/:passTypeIdentifier/:serialNumber', async (req, reply) => {
    const p = z.object({ passTypeIdentifier: z.string().max(200), serialNumber: z.string().max(64) }).parse(req.params);
    if (!cfg.apple || p.passTypeIdentifier !== cfg.apple.passTypeId) return reply.status(404).send();
    if (!(await authorise(req, reply, p.serialNumber))) return;
    const data = await loadPassData(db, { serial: p.serialNumber });
    if (!data) return reply.status(404).send();
    const ims = req.headers['if-modified-since'];
    // HTTP dates have 1 s resolution; compare at that resolution.
    if (ims && Math.floor(data.card.updated_at.getTime() / 1000) <= Math.floor(Date.parse(ims) / 1000)) {
      return reply.status(304).send();
    }
    const pkpass = await buildPkpass(cfg.apple, cfg.publicUrl, await getProgram(db), data);
    return reply
      .header('content-type', 'application/vnd.apple.pkpass')
      .header('last-modified', data.card.updated_at.toUTCString())
      .send(pkpass);
  });

  app.post('/v1/log', async (req, reply) => {
    const body = z.object({ logs: z.array(z.string().max(2000)).max(50) }).safeParse(req.body);
    if (body.success) {
      for (const m of body.data.logs) {
        log(`apple wallet log: ${m}`);
        await db.query('INSERT INTO apple_logs (message) VALUES ($1)', [m]);
      }
    }
    return reply.status(200).send();
  });
}
