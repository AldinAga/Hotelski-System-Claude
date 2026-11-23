import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { Public } from './auth/auth.guard';
import { PG_POOL } from './db/tokens';
import { Unlicensed } from './licensing/licensed-action';

/**
 * How long /health waits for the database. The compose healthcheck gives the
 * request 3 s (docker-compose.yml), so the answer, 200 or 503, must come before that.
 */
export const HEALTH_DB_TIMEOUT_MS = 2_000;

// Answers without a licence and without a user, but not without the database:
// a pool that cannot reach it (or has no free connection) is not healthy. While
// the API is still starting, deploy.sh --wait and the compose healthcheck
// (5 s interval, 30 retries, 20 s start period) keep asking, so a slow start is
// not reported as a failure.
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  @Public()
  @Unlicensed()
  async check(): Promise<{ status: 'ok' }> {
    let timer: NodeJS.Timeout | undefined;
    const ping = this.pool.query('SELECT 1');
    // If the timer wins, the query may still finish later; its outcome is not awaited by anyone.
    ping.catch(() => undefined);
    try {
      await Promise.race([
        ping,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('database did not answer')), HEALTH_DB_TIMEOUT_MS);
        }),
      ]);
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable', reason: 'database_unreachable' });
    } finally {
      clearTimeout(timer);
    }
    return { status: 'ok' };
  }
}
