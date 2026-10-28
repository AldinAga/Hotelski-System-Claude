import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '@/lib/api';
import { apiError, mockFetch, type Call } from '@/test/fetch-mock';
import CalendarPage from './page';

const DBL = '11111111-1111-4111-8111-111111111111';
const U101 = '22222222-2222-4222-8222-222222222222';
const U102 = '33333333-3333-4333-8333-333333333333';
const RES = '55555555-5555-4555-8555-555555555555';
const STAY = '66666666-6666-4666-8666-666666666666';

const LICENCE = { activated: true, modules: ['hotel.core'], limits: {} };

function calendar(from: string, n: number) {
  const days = Array.from({ length: n }, (_, i) =>
    new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
  );
  return {
    days,
    availability: [{ scope: { kind: 'unit_type', id: DBL }, label: 'Dvokrevetna', free: days.map(() => 1) }],
    units: [
      {
        id: U101,
        name: 'Soba 101',
        unitTypeId: DBL,
        cleanliness: 'clean',
        bars: [
          {
            kind: 'stay',
            stayId: 's1',
            reservationId: 'r1',
            number: 'R-2026-000001',
            guest: 'Petar Petrović',
            arrival: '2026-11-03',
            departure: '2026-11-05',
            status: 'expected',
          },
        ],
      },
      { id: U102, name: 'Soba 102', unitTypeId: DBL, cleanliness: 'clean', bars: [] },
    ],
    unassigned: [
      {
        stayId: STAY,
        reservationId: RES,
        number: 'R-2026-000009',
        guest: 'Ana Anić',
        unitTypeId: DBL,
        arrival: '2026-11-07',
        departure: '2026-11-09',
        version: 3,
      },
    ],
  };
}

function routes(state: string, extra: Record<string, unknown> = {}) {
  return {
    'GET /api/licence': { body: { ...LICENCE, state } },
    'GET /api/calendar': (c: Call) => {
      const q = new URLSearchParams(c.url.split('?')[1]);
      const from = q.get('from')!;
      const n = Math.round((Date.parse(q.get('to')!) - Date.parse(from)) / 86_400_000);
      return { body: calendar(from, n) };
    },
    ...extra,
  } as Parameters<typeof mockFetch>[0];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T10:00:00+01:00'));
  vi.spyOn(navigation, 'go').mockImplementation(() => undefined);
  window.history.replaceState(null, '', '/kalendar');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('/kalendar', () => {
  it('u sigurnom režimu dugme Nova rezervacija je onemogućeno, kalendar se prikazuje', async () => {
    mockFetch(routes('EXPIRED'));
    render(<CalendarPage />);
    expect(await screen.findByRole('link', { name: /R-2026-000001/ })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: 'Soba 101' })).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Nova rezervacija' })).toBeDisabled());
    // Changes from the grid are off too.
    expect(screen.getByRole('button', { name: 'Soba 102, 4.11.2026' })).toBeDisabled();
  });

  it('with a valid licence the button opens a new reservation; a cell opens it on that unit and day', async () => {
    mockFetch(routes('VALID'));
    const user = userEvent.setup();
    render(<CalendarPage />);
    await screen.findByRole('link', { name: /R-2026-000001/ });
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Nova rezervacija' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Nova rezervacija' }));
    expect(navigation.go).toHaveBeenLastCalledWith('/rezervacije/nova');
    await user.click(screen.getByRole('button', { name: 'Soba 102, 4.11.2026' }));
    expect(navigation.go).toHaveBeenLastCalledWith(`/rezervacije/nova?unitId=${U102}&arrival=2026-11-04`);
  });

  it('shows 14 days from today by default and 31 when chosen', async () => {
    const calls = mockFetch(routes('VALID'));
    render(<CalendarPage />);
    await screen.findByRole('link', { name: /R-2026-000001/ });
    expect(calls.filter((c) => c.url.startsWith('/api/calendar')).map((c) => c.url)).toEqual([
      '/api/calendar?from=2026-11-01&to=2026-11-15',
    ]);
    fireEvent.change(screen.getByLabelText('Prikaz'), { target: { value: '31' } });
    await vi.waitFor(() =>
      expect(calls.map((c) => c.url)).toContain('/api/calendar?from=2026-11-01&to=2026-12-02'),
    );
  });

  it('assigning posts the version the calendar showed (no fresh read), then reloads the calendar', async () => {
    const calls = mockFetch(
      routes('VALID', { [`POST /api/stays/${STAY}/assign-unit`]: { body: { stayId: STAY, unitId: U102, version: 4 } } }),
    );
    const user = userEvent.setup();
    render(<CalendarPage />);
    const item = await screen.findByRole('listitem', { name: /R-2026-000009/ });
    await user.selectOptions(within(item).getByLabelText('Jedinica'), U102);
    await user.click(within(item).getByRole('button', { name: 'Dodeli' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Boravak je dodeljen jedinici Soba 102.');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', url: `/api/stays/${STAY}/assign-unit`, body: { unitId: U102, version: 3 } },
    ]);
    expect(calls.some((c) => c.url.startsWith('/api/reservations'))).toBe(false);
    expect(calls.filter((c) => c.url.startsWith('/api/calendar'))).toHaveLength(2);
  });

  it('a stale calendar (a colleague already assigned the stay) is refused: message, reload, the stay is not moved', async () => {
    let assigned = false;
    const calls = mockFetch(
      routes('VALID', {
        // The server's current version is 4: a fresh read would get it and move the stay silently.
        [`GET /api/reservations/${RES}`]: { body: { id: RES, version: 4, stays: [] } },
        [`POST /api/stays/${STAY}/assign-unit`]: (c: Call) =>
          (c.body as { version: number }).version === 4
            ? { body: { stayId: STAY, unitId: U102, version: 5 } }
            : apiError(409, 'version_conflict', 'x', { version: 4 }),
        'GET /api/calendar': (c: Call) => {
          const q = new URLSearchParams(c.url.split('?')[1]);
          const v = calendar(q.get('from')!, 14);
          // After the reload the stay shows where the colleague put it.
          return { body: assigned ? { ...v, unassigned: [] } : v };
        },
      }),
    );
    const user = userEvent.setup();
    render(<CalendarPage />);
    const item = await screen.findByRole('listitem', { name: /R-2026-000009/ });
    assigned = true;
    await user.selectOptions(within(item).getByLabelText('Jedinica'), U102);
    await user.click(within(item).getByRole('button', { name: 'Dodeli' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Rezervacija je promenjena u međuvremenu. Kalendar je osvežen; proverite i pokušajte ponovo.',
    );
    await vi.waitFor(() => expect(screen.queryByRole('listitem', { name: /R-2026-000009/ })).toBeNull());
    expect(calls.filter((c) => c.url.startsWith('/api/calendar'))).toHaveLength(2);
    // Only the calendar's (stale) version was ever sent, and it was refused.
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ unitId: U102, version: 3 }]);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a refused assign shows the dictionary message', async () => {
    mockFetch(routes('VALID', { [`POST /api/stays/${STAY}/assign-unit`]: apiError(409, 'unit_taken') }));
    const user = userEvent.setup();
    render(<CalendarPage />);
    const item = await screen.findByRole('listitem', { name: /R-2026-000009/ });
    await user.selectOptions(within(item).getByLabelText('Jedinica'), U102);
    await user.click(within(item).getByRole('button', { name: 'Dodeli' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Jedinica je već zauzeta u tom periodu.');
  });

  it('a failed load is cleared by the next successful one', async () => {
    let fail = true;
    mockFetch(
      routes('VALID', {
        'GET /api/calendar': (c: Call) => {
          if (fail) return { status: 503, body: { code: 'network_error', message: '', details: null } };
          const q = new URLSearchParams(c.url.split('?')[1]);
          return { body: calendar(q.get('from')!, 31) };
        },
      }),
    );
    render(<CalendarPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Server nije dostupan.');
    fail = false;
    fireEvent.change(screen.getByLabelText('Prikaz'), { target: { value: '31' } });
    expect(await screen.findByRole('link', { name: /R-2026-000001/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
