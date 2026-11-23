import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SetupService } from '../src/auth/setup.service';
import { NightAuditScheduler } from '../src/business-day/night-audit.scheduler';
import * as migrateModule from '../src/db/migrate';
import { LicenceService } from '../src/licensing/licence.service';
import { OutboxDispatcher } from '../src/mail/outbox.dispatcher';
import { startServices } from '../src/start-services';
import { createTestApp, type TestApp } from './app';

// main.ts cannot be imported (it starts the process), so what it does before
// listen() lives in startServices and is run here on a real app: both background
// jobs are started, after migrations and the licence, and they stop with the app.

describe('startServices', () => {
  let ta: TestApp;
  let closed = false;

  beforeAll(async () => {
    ta = await createTestApp();
  });
  afterAll(async () => {
    if (!closed) await ta.app.close();
  });

  const timerOf = (job: object) => (job as { timer: unknown }).timer;

  it('starts the night audit scheduler and the outbox dispatcher after migrations and the licence, and stops them on close', async () => {
    const calls: string[] = [];
    const scheduler = ta.app.get(NightAuditScheduler);
    const dispatcher = ta.app.get(OutboxDispatcher);
    jest.spyOn(migrateModule, 'migrate').mockImplementation(async () => {
      calls.push('migrate');
      return [];
    });
    jest.spyOn(ta.app.get(SetupService), 'prepareOnBoot').mockImplementation(async () => {
      calls.push('setup');
      return null;
    });
    jest.spyOn(ta.app.get(LicenceService), 'start').mockImplementation(async () => {
      calls.push('licence');
    });
    const startScheduler = jest.spyOn(scheduler, 'start');
    const startDispatcher = jest.spyOn(dispatcher, 'start');
    startScheduler.mockImplementation(() => {
      calls.push('scheduler');
      NightAuditScheduler.prototype.start.call(scheduler);
    });
    startDispatcher.mockImplementation(() => {
      calls.push('dispatcher');
      OutboxDispatcher.prototype.start.call(dispatcher);
    });

    try {
      expect(timerOf(scheduler)).toBeNull();
      expect(timerOf(dispatcher)).toBeNull();

      await startServices(ta.app);

      expect(calls).toEqual(['migrate', 'setup', 'licence', 'scheduler', 'dispatcher']);
      expect(timerOf(scheduler)).not.toBeNull();
      expect(timerOf(dispatcher)).not.toBeNull();

      await ta.app.close();
      closed = true;

      expect(timerOf(scheduler)).toBeNull();
      expect(timerOf(dispatcher)).toBeNull();
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('main.ts runs it before it listens (the process entry cannot be imported, so its text is read)', () => {
    const main = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8');
    const start = main.indexOf('await startServices(app);');
    expect(start).toBeGreaterThan(-1);
    expect(main.indexOf('await app.listen(port);')).toBeGreaterThan(start);
  });
});
