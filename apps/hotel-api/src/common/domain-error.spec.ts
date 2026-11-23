import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import { DATABASE_BUSY_MESSAGE, DomainError, DomainErrorFilter, isDatabaseBusy } from './domain-error';

function answer(error: unknown): { status: number; body: unknown } {
  const out = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  new DomainErrorFilter().catch(error, host);
  return out;
}

describe('isDatabaseBusy', () => {
  it.each([
    ['a statement cut by statement_timeout', Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })],
    ['a lock wait cut by lock_timeout', Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })],
    ['the same wrapped by Drizzle', Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('x'), { code: '57014' }) })],
    ['the pool giving up on a connection', new Error('timeout exceeded when trying to connect')],
    ['a connection that timed out while opening', new Error('Connection terminated due to connection timeout')],
  ])('%s is busy', (_name, err) => {
    expect(isDatabaseBusy(err)).toBe(true);
  });

  it.each([
    ['a unique violation', Object.assign(new Error('duplicate key'), { code: '23505' })],
    ['a plain error', new Error('boom')],
    ['null', null],
  ])('%s is not', (_name, err) => {
    expect(isDatabaseBusy(err)).toBe(false);
  });
});

describe('DomainErrorFilter', () => {
  it('answers a DomainError with its status and code', () => {
    expect(answer(new DomainError('folio_closed', 'Folio je zatvoren.', 409, { a: 1 }))).toEqual({
      status: 409,
      body: { code: 'folio_closed', message: 'Folio je zatvoren.', details: { a: 1 } },
    });
  });

  it('answers a database timeout with 503 and a fixed text that never carries the driver message', () => {
    const r = answer(Object.assign(new Error('canceling statement due to statement timeout (host 10.0.0.5)'), { code: '57014' }));
    expect(r).toEqual({ status: 503, body: { code: 'database_busy', message: DATABASE_BUSY_MESSAGE, details: null } });
    expect(JSON.stringify(r.body)).not.toContain('10.0.0.5');
  });

  it('answers an HttpException as Nest does', () => {
    expect(answer(new BadRequestException('nope'))).toEqual({
      status: 400,
      body: { statusCode: 400, message: 'nope', error: 'Bad Request' },
    });
  });

  it('answers an http-errors object from middleware with its own status', () => {
    expect(answer(Object.assign(new Error('request entity too large'), { statusCode: 413 }))).toEqual({
      status: 413,
      body: { statusCode: 413, message: 'request entity too large' },
    });
  });

  it('answers anything else with a bare 500', () => {
    expect(answer(new Error('secret detail'))).toEqual({ status: 500, body: { statusCode: 500, message: 'Internal server error' } });
  });
});
