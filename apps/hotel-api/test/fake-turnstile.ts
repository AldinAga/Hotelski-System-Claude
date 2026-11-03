import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// A real HTTP stand-in for Cloudflare's siteverify endpoint
// (POST https://challenges.cloudflare.com/turnstile/v0/siteverify). It answers
// like Cloudflare does: success only for the expected secret and a token it
// issued (PASS_TOKEN), with the action and hostname the widget would report.

export const FAKE_SECRET = 'fake-turnstile-secret-0123456789';
export const PASS_TOKEN = 'XXXX.pass-token';

export type FakeMode = 'normal' | 'status-500' | 'hang' | 'not-json';

export interface SiteverifyRequest {
  contentType: string | undefined;
  body: Record<string, unknown>;
}

export interface FakeTurnstile {
  url: string;
  requests: SiteverifyRequest[];
  setMode(mode: FakeMode): void;
  /** Fields of a successful answer (action, hostname); reset by reset(). */
  setAnswer(patch: Record<string, unknown>): void;
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeTurnstile(): Promise<FakeTurnstile> {
  const requests: SiteverifyRequest[] = [];
  let mode: FakeMode = 'normal';
  let answer: Record<string, unknown> = {};

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = {};
      }
      requests.push({ contentType: req.headers['content-type'], body });
      if (mode === 'hang') return; // never answers; the client must time out
      if (mode === 'status-500') {
        // JSON on purpose: only the status says "unavailable", so the status
        // check is what turns this into 503 (not the JSON parse).
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ success: false, 'error-codes': ['internal-error'] }));
      }
      if (mode === 'not-json') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html>maintenance</html>');
      }
      const ok = req.method === 'POST' && body.secret === FAKE_SECRET && body.response === PASS_TOKEN;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          ok
            ? {
                success: true,
                'error-codes': [],
                challenge_ts: new Date().toISOString(),
                hostname: 'recepcija.hotel.rs',
                action: 'login',
                cdata: '',
                ...answer,
              }
            : { success: false, 'error-codes': [body.secret === FAKE_SECRET ? 'invalid-input-response' : 'invalid-input-secret'] },
        ),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/turnstile/v0/siteverify`,
    requests,
    setMode(m: FakeMode) {
      mode = m;
    },
    setAnswer(patch: Record<string, unknown>) {
      answer = { ...answer, ...patch };
    },
    reset() {
      mode = 'normal';
      answer = {};
      requests.length = 0;
    },
    close(): Promise<void> {
      server.closeAllConnections();
      return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
