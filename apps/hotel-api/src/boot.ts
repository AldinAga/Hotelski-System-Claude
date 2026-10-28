import { createServer, type Server } from 'node:http';

// Start-up guard for hotel-api. On the NAS the container runs with
// `restart: unless-stopped`, and Synology mails for every stop, so a process
// that exits on a bad start (failed migration, malformed HOTEL_ROOT_KEYSET or
// HOTEL_SECRET_KEY, unreachable database) would crash-loop and flood mail.
// Instead the failure is logged without secret values and the process keeps a
// minimal server on the same port that answers 503 to every path: the
// container stays Up (unhealthy), and `compose up --wait` still fails visibly.

export type BootLog = (line: string) => void;

export interface BootOptions {
  port: number;
  log: BootLog;
  /** Source of the secret values to hide from the log; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

const SECRET_NAME = /SECRET|PASSWORD|TOKEN|KEYSET|_KEY$|DATABASE_URL/;
const MIN_SECRET_LENGTH = 4;
const REDACTED = '[redacted]';

/** Replaces every value of a secret-looking env variable (and a URL's password) in `text`. */
export function redactSecrets(text: string, env: Record<string, string | undefined>): string {
  const values = new Set<string>();
  for (const [name, raw] of Object.entries(env)) {
    const value = raw?.trim();
    if (!value || !SECRET_NAME.test(name)) continue;
    if (value.length >= MIN_SECRET_LENGTH) values.add(value);
    try {
      const password = decodeURIComponent(new URL(value).password);
      if (password.length >= MIN_SECRET_LENGTH) values.add(password);
    } catch {
      // Not a URL; the whole value is already covered.
    }
  }
  // Longest first, so a URL goes before the password inside it.
  let out = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    out = out.split(value).join(REDACTED);
  }
  return out;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}

/** Listens on `port` and answers 503 to every request. */
export function startFallbackServer(port: number): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'unavailable', reason: 'bootstrap_failed' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

/**
 * Runs `bootstrap`. On success returns null. On failure logs the error with
 * secrets redacted and returns the 503 fallback server, which keeps the
 * process alive.
 */
export async function bootOrDegrade(bootstrap: () => Promise<void>, options: BootOptions): Promise<Server | null> {
  const env = options.env ?? process.env;
  try {
    await bootstrap();
    return null;
  } catch (err) {
    options.log(`hotel-api did not start: ${redactSecrets(describeError(err), env)}`);
    options.log(
      `hotel-api answers 503 on port ${options.port} until the cause is fixed and the container is restarted`,
    );
    try {
      return await startFallbackServer(options.port);
    } catch (listenErr) {
      // Even without a port the process must not exit: stay alive, unhealthy.
      options.log(`the 503 fallback could not listen: ${redactSecrets(describeError(listenErr), env)}`);
      setInterval(() => undefined, 1 << 30);
      return null;
    }
  }
}
