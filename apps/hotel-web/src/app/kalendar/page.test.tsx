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

  it('assigning an unassigned stay reads its version, posts assign-unit and reloads the calendar', async () => {
    const calls = mockFetch(
      routes('VALID', {
        [`GET /api/reservations/${RES}`]: { body: { id: RES, version: 3, stays: [] } },
        [`POST /api/stays/${STAY}/assign-unit`]: { body: { stayId: STAY, unitId: U102, version: 4 } },
      }),
    );
    const user = userEvent.setup();
    render(<CalendarPage />);
    const item = await screen.findByRole('listitem', { name: /R-2026-000009/ });
    await user.selectOptions(within(item).getByLabelText('Jedinica'), U102);
    await user.click(within(item).getByRole('button', { name: 'Dodeli' }));

    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      url: `/api/stays/${STAY}/assign-unit`,
      body: { unitId: U102, version: 3 },
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Boravak je dodeljen jedinici Soba 102.');
    expect(calls.filter((c) => c.url.startsWith('/api/calendar'))).toHaveLength(2);
  });

  it('a refused assign shows the dictionary message', async () => {
    mockFetch(
      routes('VALID', {
        [`GET /api/reservations/${RES}`]: { body: { id: RES, version: 3, stays: [] } },
        [`POST /api/stays/${STAY}/assign-unit`]: apiError(409, 'unit_taken'),
      }),
    );
    const user = userEvent.setup();
    render(<CalendarPage />);
    const item = await screen.findByRole('listitem', { name: /R-2026-000009/ });
    await user.selectOptions(within(item).getByLabelText('Jedinica'), U102);
    await user.click(within(item).getByRole('button', { name: 'Dodeli' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Jedinica je već zauzeta u tom periodu.');
  });
});
