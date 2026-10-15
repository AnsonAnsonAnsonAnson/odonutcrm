import http2 from 'node:http2';
import type { AppleConfig } from './pass.js';

export interface ApnsResult { token: string; status: number; reason?: string }

/**
 * Sends the empty "pass changed" push Apple Wallet expects. The device then calls our
 * web service, downloads the new pass, and shows any changeMessage on the lock screen.
 * Wallet pushes must be authenticated with the Pass Type ID certificate (not an APNs auth key).
 */
export class Apns {
  private session: http2.ClientHttp2Session | null = null;
  constructor(private apple: AppleConfig, private log: (m: string) => void) {}

  private connect(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const s = http2.connect(this.apple.apnsHost, {
      cert: this.apple.cert,
      key: this.apple.key,
      passphrase: this.apple.keyPassphrase,
    });
    s.on('error', (err) => this.log(`apns session error: ${err.message}`));
    s.on('goaway', () => s.close());
    s.setTimeout(5 * 60_000, () => s.close());
    this.session = s;
    return s;
  }

  private sendOne(token: string): Promise<ApnsResult> {
    return new Promise((resolve) => {
      let s: http2.ClientHttp2Session;
      try {
        s = this.connect();
      } catch (err: any) {
        resolve({ token, status: 0, reason: err.message });
        return;
      }
      const req = s.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        'apns-topic': this.apple.passTypeId,
        'content-type': 'application/json',
      });
      let status = 0;
      let body = '';
      req.setTimeout(10_000, () => {
        req.close();
        resolve({ token, status: 0, reason: 'timeout' });
      });
      req.on('response', (h) => (status = Number(h[':status'])));
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        let reason: string | undefined;
        try {
          reason = body ? JSON.parse(body).reason : undefined;
        } catch {}
        resolve({ token, status, reason });
      });
      req.on('error', (err) => resolve({ token, status: 0, reason: err.message }));
      req.end('{}');
    });
  }

  async send(tokens: string[]): Promise<ApnsResult[]> {
    const results: ApnsResult[] = [];
    // Modest concurrency keeps one HTTP/2 connection busy without flooding it.
    for (let i = 0; i < tokens.length; i += 50) {
      results.push(...(await Promise.all(tokens.slice(i, i + 50).map((t) => this.sendOne(t)))));
    }
    return results;
  }

  close() {
    this.session?.close();
  }
}
