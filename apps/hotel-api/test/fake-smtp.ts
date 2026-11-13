import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';

// A plain SMTP server on a random local port (no TLS, no AUTH) that keeps what
// it receives. rejectRecipients makes every RCPT TO answer with a code, so the
// tests can see how 5xx and 4xx answers are classified.

export interface ReceivedMail {
  from: string | null;
  to: string[];
  /** The raw message, headers and body. */
  data: string;
}

export interface FakeSmtp {
  port: number;
  received: ReceivedMail[];
  /** From now on every recipient is refused with `code` and `text` (the text must never reach the app's records). */
  rejectRecipients(code: number, text: string): void;
  close(): Promise<void>;
}

/** The value of one header of a raw message (folded lines joined); null when absent. */
export function headerOf(raw: string, name: string): string | null {
  const head = raw.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, ' ');
  const line = head.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ? line.slice(name.length + 1).trim() : null;
}

export async function startFakeSmtp(): Promise<FakeSmtp> {
  const received: ReceivedMail[] = [];
  let rejection: { code: number; text: string } | null = null;
  const server = new SMTPServer({
    logger: false,
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    onRcptTo(_address, _session, callback) {
      if (!rejection) return callback();
      const err = new Error(rejection.text) as Error & { responseCode: number };
      err.responseCode = rejection.code;
      return callback(err);
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : null,
          to: session.envelope.rcptTo.map((r) => r.address),
          data: Buffer.concat(chunks).toString('utf8'),
        });
        callback();
      });
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.server.address() as AddressInfo).port;
  return {
    port,
    received,
    rejectRecipients(code, text) {
      rejection = { code, text };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
