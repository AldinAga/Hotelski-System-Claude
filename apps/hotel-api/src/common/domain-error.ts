import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const DATABASE_BUSY_MESSAGE = 'Baza podataka trenutno ne odgovara. Pokušajte ponovo za nekoliko trenutaka.';

/**
 * A database call that gave up waiting (db/pool.ts timeouts): no free pooled
 * connection in time (pg's own message, no code), a statement cut by
 * statement_timeout (57014) or a lock wait cut by lock_timeout (55P03), raw or
 * wrapped by Drizzle.
 */
export function isDatabaseBusy(err: unknown): boolean {
  const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  const codes = [e?.code, e?.cause?.code];
  if (codes.includes('57014') || codes.includes('55P03')) return true;
  return [e?.message, e?.cause?.message].some(
    (m) => m === 'timeout exceeded when trying to connect' || m === 'Connection terminated due to connection timeout',
  );
}

const log = new Logger('ExceptionsHandler');

/**
 * The global filter. A DomainError answers with its own status and code. A
 * database timeout answers 503 database_busy with a fixed Serbian text (never
 * the driver's message). Everything else answers as Nest's own default does.
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (error instanceof DomainError) {
      res.status(error.status).json({ code: error.code, message: error.message, details: error.details ?? null });
      return;
    }
    if (isDatabaseBusy(error)) {
      log.error(`database timeout: ${(error as Error).message}`);
      res.status(503).json({ code: 'database_busy', message: DATABASE_BUSY_MESSAGE, details: null });
      return;
    }
    if (error instanceof HttpException) {
      const body = error.getResponse();
      res.status(error.getStatus()).json(typeof body === 'string' ? { statusCode: error.getStatus(), message: body } : body);
      return;
    }
    // An http-errors object from Express middleware (body too large, ...): Nest's default answers with its own status.
    const external = error as { statusCode?: unknown; message?: unknown } | null;
    if (typeof external?.statusCode === 'number' && typeof external.message === 'string' && external.statusCode >= 400 && external.statusCode < 600) {
      res.status(external.statusCode).json({ statusCode: external.statusCode, message: external.message });
      return;
    }
    log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    res.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }
}
