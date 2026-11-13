import { SAFE_MODE_ALLOWED } from '../src/licensing/safe-mode';
import { DAY_MS, startFrontDesk, type FrontDesk } from './front-desk';
import { discoverRoutes, type RouteInfo } from './routes';

// One table of every phase 1b route against what the licence lets through
// after it expires (safe mode). The expectation is this list, written by hand
// from the plan; the routes and their actions are read from the running app,
// and the table is checked twice: against SAFE_MODE_ALLOWED (the code's list)
// and against what the global guard actually does to a request.
const ALLOWED_IN_SAFE_MODE = new Set([
  'GET /guests',
  'GET /stays/:id/folio',
  'POST /stays/:id/folio/payments',
  'POST /stays/:id/folio/refunds',
  'POST /stays/:id/folio/documents',
  'GET /stays/:id/folio/documents',
  'GET /folio-documents/:id',
  'GET /stays/:id/check-out-preview',
  'POST /stays/:id/check-out',
  'GET /business-day',
  'POST /business-day/close',
  'GET /business-days',
  'GET /business-days/:day',
  'GET /settings/business',
  'GET /legal-profile',
  'GET /reservations/:id/messages',
]);

// The actions phase 1b added; phase 1a routes stay covered by their own specs.
const ACTIONS_1B = /^(guest\.|stay\.check_|folio\.|business_day\.|settings\.|legal_profile\.|message\.)/;

type Route1b = RouteInfo & { key: string; module: string; action: string };

function routes1b(app: FrontDesk['app']): Route1b[] {
  return discoverRoutes(app)
    .filter((r): r is RouteInfo & { module: string; action: string } => r.action !== undefined && r.module !== undefined)
    .filter((r) => ACTIONS_1B.test(r.action))
    .map((r) => ({ ...r, key: `${r.method} ${r.path}` }));
}

const ZERO_UUID = '00000000-0000-4000-8000-000000000000';
const concretePath = (path: string) => path.replace(/:day\b/, '2026-11-02').replace(/:[A-Za-z]+/g, ZERO_UUID);

describe('phase 1b routes in safe mode (e2e)', () => {
  let fd: FrontDesk;
  let routes: Route1b[];

  beforeAll(async () => {
    fd = await startFrontDesk();
    routes = routes1b(fd.app);
  });
  beforeEach(async () => {
    await fd.reset();
  });
  afterAll(async () => {
    await fd.close();
  });

  it('the scan sees the phase 1b routes (not vacuous)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(25);
    expect(new Set(routes.map((r) => r.key)).size).toBe(routes.length);
  });

  it('a 1b route is on the hand-written list exactly when SAFE_MODE_ALLOWED allows its action', () => {
    const listedButNotAllowed = routes
      .filter((r) => ALLOWED_IN_SAFE_MODE.has(r.key) && !SAFE_MODE_ALLOWED.has(r.action))
      .map((r) => `${r.key} (${r.action})`);
    const allowedButNotListed = routes
      .filter((r) => !ALLOWED_IN_SAFE_MODE.has(r.key) && SAFE_MODE_ALLOWED.has(r.action))
      .map((r) => `${r.key} (${r.action})`);
    expect(listedButNotAllowed).toEqual([]);
    expect(allowedButNotListed).toEqual([]);
  });

  it('every route on the hand-written list exists (a renamed route cannot drop out silently)', () => {
    const existing = new Set(routes.map((r) => r.key));
    expect([...ALLOWED_IN_SAFE_MODE].filter((key) => !existing.has(key))).toEqual([]);
  });

  it('after expiry the guard blocks every other 1b route with safe_mode_blocked and lets the listed ones through', async () => {
    fd.shiftLicence(400 * DAY_MS); // past valid_until and grace_until
    expect((await fd.get('/licence')).body.state).toBe('EXPIRED');

    const wronglyBlocked: string[] = [];
    const wronglyAllowed: string[] = [];
    for (const r of routes) {
      const path = concretePath(r.path);
      const send = (cookie: string) =>
        r.method === 'GET'
          ? fd.get(path, cookie)
          : r.method === 'POST'
            ? fd.post(path, {}, cookie)
            : r.method === 'PUT'
              ? fd.put(path, {}, cookie)
              : r.method === 'PATCH'
                ? fd.patch(path, {}, cookie)
                : fd.del(path, cookie);
      const res = await send(fd.owner);
      const blocked = res.status === 403 && res.body?.code === 'safe_mode_blocked';
      const listed = ALLOWED_IN_SAFE_MODE.has(r.key);
      if (listed && blocked) wronglyBlocked.push(`${r.key} (${r.action})`);
      if (!listed && !blocked) wronglyAllowed.push(`${r.key} (${r.action}) -> ${res.status} ${res.body?.code ?? ''}`);
      // Whatever a listed route answers (200, 404, 422), it was not refused for the licence.
      if (listed) expect([r.key, res.status === 401 || res.body?.code === 'route_not_classified']).toEqual([r.key, false]);
    }
    expect(wronglyBlocked).toEqual([]);
    expect(wronglyAllowed).toEqual([]);
  });
});
