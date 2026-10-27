import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DomainError, DomainErrorFilter } from './domain-error';

@Controller('boom')
class BoomController {
  @Get('with-details')
  withDetails(): never {
    throw new DomainError('room_taken', 'Soba je zauzeta.', 422, { room: 7 });
  }

  @Get('plain')
  plain(): never {
    throw new DomainError('nope', 'Ne može.', 409);
  }
}

describe('DomainErrorFilter', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ controllers: [BoomController] }).compile();
    app = mod.createNestApplication();
    app.useGlobalFilters(new DomainErrorFilter());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('answers with the error status and { code, message, details }', async () => {
    const res = await request(app.getHttpServer()).get('/boom/with-details');
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ code: 'room_taken', message: 'Soba je zauzeta.', details: { room: 7 } });
  });

  it('sends details as null when there are none', async () => {
    const res = await request(app.getHttpServer()).get('/boom/plain');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'nope', message: 'Ne može.', details: null });
  });
});
