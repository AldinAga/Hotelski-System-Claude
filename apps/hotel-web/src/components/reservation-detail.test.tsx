import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '@/lib/api';
import { apiError, mockFetch } from '@/test/fetch-mock';
import { ReservationDetail } from './reservation-detail';

const RES = '55555555-5555-4555-8555-555555555555';
const TYPE = { id: '11111111-1111-4111-8111-111111111111', code: 'DBL', name: { sr: 'Dvokrevetna' }, capacity: 2, beds: null, description: null, active: true };

const RESERVATION = {
  id: RES,
  number: 'R-2026-000001',
  status: 'confirmed',
  source: 'front_desk',
  channel: null,
  externalId: null,
  guarantee: null,
  note: null,
  version: 2,
  createdAt: '2026-11-01T09:00:00.000Z',
  holder: { id: 'g', firstName: 'Petar', lastName: 'Petrović', email: null, phone: null, language: 'sr' },
  stays: [
    {
      id: 's1',
      unitTypeId: TYPE.id,
      unitId: null,
      // Starts before any calendar range that clipped it: the real dates are here.
      arrival: '2026-10-28',
      departure: '2026-11-03',
      adults: 2,
      children: 0,
      ratePlanId: 'p',
      status: 'expected',
      nights: [],
      totalMinor: 6_000_000,
    },
  ],
  totalMinor: 6_000_000,
};

function routes(state: string, extra: Record<string, unknown> = {}) {
  return {
    'GET /api/licence': { body: { activated: true, modules: ['hotel.core'], limits: {}, state } },
    [`GET /api/reservations/${RES}`]: { body: RESERVATION },
    'GET /api/unit-types': { body: [TYPE] },
    'GET /api/units': { body: [] },
    ...extra,
  } as Parameters<typeof mockFetch>[0];
}

beforeEach(() => {
  vi.spyOn(navigation, 'go').mockImplementation(() => undefined);
  window.history.replaceState(null, '', `/rezervacije/${RES}`);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ReservationDetail', () => {
  it('shows the real stay dates and cancels with the current version after confirming', async () => {
    const calls = mockFetch(routes('VALID', { [`POST /api/reservations/${RES}/cancel`]: { body: { id: RES, status: 'cancelled', version: 3 } } }));
    const user = userEvent.setup();
    render(<ReservationDetail id={RES} />);
    expect(await screen.findByText('28.10.2026 – 3.11.2026')).toBeInTheDocument();
    expect(screen.getByText('Ukupno: 60.000,00 RSD')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Otkaži rezervaciju' }));
    await user.click(screen.getByRole('button', { name: 'Da, otkaži' }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      url: `/api/reservations/${RES}/cancel`,
      body: { version: 2 },
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Rezervacija je otkazana.');
  });

  it('a stale version shows the dictionary message', async () => {
    mockFetch(routes('VALID', { [`POST /api/reservations/${RES}/cancel`]: apiError(409, 'version_conflict', 'x', { version: 3 }) }));
    const user = userEvent.setup();
    render(<ReservationDetail id={RES} />);
    await user.click(await screen.findByRole('button', { name: 'Otkaži rezervaciju' }));
    await user.click(screen.getByRole('button', { name: 'Da, otkaži' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Rezervaciju je u međuvremenu neko izmenio. Osvežite prikaz i pokušajte ponovo.',
    );
  });

  it('in safe mode cancelling is disabled; the reservation is still shown', async () => {
    mockFetch(routes('EXPIRED'));
    render(<ReservationDetail id={RES} />);
    expect(await screen.findByText('28.10.2026 – 3.11.2026')).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Otkaži rezervaciju' })).toBeDisabled());
  });
});
