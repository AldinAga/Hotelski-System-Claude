import { render, screen, within } from '@testing-library/react';
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
      guests: [],
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
    'GET /api/business-day': { body: { day: '2026-10-28' } },
    [`GET /api/reservations/${RES}/messages`]: { body: [] },
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

  it('a one-night stay reads "1 noć", a longer one "6 noći"', async () => {
    const oneNight = { ...RESERVATION.stays[0], id: 's2', arrival: '2026-11-10', departure: '2026-11-11', totalMinor: 1_000_000 };
    mockFetch(
      routes('VALID', { [`GET /api/reservations/${RES}`]: { body: { ...RESERVATION, stays: [RESERVATION.stays[0], oneNight] } } }),
    );
    render(<ReservationDetail id={RES} />);
    const one = await screen.findByRole('listitem', { name: 'Boravak 10.11.2026 – 11.11.2026' });
    expect(one).toHaveTextContent(/^.*1 noć · /);
    expect(one).not.toHaveTextContent('noći');
    expect(screen.getByRole('listitem', { name: 'Boravak 28.10.2026 – 3.11.2026' })).toHaveTextContent('6 noći');
  });

  describe('moving a stay to another unit (final review, Important 2)', () => {
    const OTHER_TYPE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const unit = (id: string, name: string, unitTypeId: string | null, active = true) => ({
      id,
      name,
      unitTypeId,
      address: null,
      municipality: null,
      eturistaObjectId: null,
      active,
      cleanliness: 'clean',
    });
    const U101 = unit('u101', 'Soba 101', TYPE.id);
    const U102 = unit('u102', 'Soba 102', TYPE.id);
    const U103 = unit('u103', 'Soba 103', TYPE.id, false);
    const U201 = unit('u201', 'Apartman 201', OTHER_TYPE);
    const U301 = unit('u301', 'Bez tipa 301', null);
    const UNITS = [U101, U102, U103, U201, U301];
    const assigned = { ...RESERVATION, stays: [{ ...RESERVATION.stays[0], unitId: U101.id }] };

    function moveRoutes(reservation: unknown, extra: Record<string, unknown> = {}, state = 'VALID') {
      return routes(state, {
        [`GET /api/reservations/${RES}`]: { body: reservation },
        'GET /api/units': { body: UNITS },
        ...extra,
      });
    }

    const stayItem = () => screen.findByRole('listitem', { name: 'Boravak 28.10.2026 – 3.11.2026' });

    it('offers only active units of the stay type and moves it with the version the screen read', async () => {
      const calls = mockFetch(
        moveRoutes(assigned, { 'POST /api/stays/s1/assign-unit': { body: { stayId: 's1', unitId: U102.id, version: 3 } } }),
      );
      const user = userEvent.setup();
      render(<ReservationDetail id={RES} />);
      const item = await stayItem();
      const select = within(item).getByRole('combobox', { name: 'Jedinica' });
      const options = within(select)
        .getAllByRole('option')
        .map((o) => o.textContent);
      expect(options).toEqual(['Soba 101', 'Soba 102']);
      expect(select).toHaveValue(U101.id);
      // Nothing to send while the current unit is selected.
      expect(within(item).getByRole('button', { name: 'Premesti' })).toBeDisabled();

      await user.selectOptions(select, U102.id);
      await user.click(within(item).getByRole('button', { name: 'Premesti' }));
      await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
      expect(calls.find((c) => c.method === 'POST')).toEqual({
        method: 'POST',
        url: '/api/stays/s1/assign-unit',
        body: { unitId: U102.id, version: 2 },
      });
      expect(await screen.findByRole('status')).toHaveTextContent('Boravak je premešten na jedinicu Soba 102.');
      // The page reads the reservation again (new version, new unit).
      expect(calls.filter((c) => c.url === `/api/reservations/${RES}`)).toHaveLength(2);
    });

    it('an unassigned typed stay gets a unit the same way ("Dodeli")', async () => {
      const calls = mockFetch(
        moveRoutes(RESERVATION, { 'POST /api/stays/s1/assign-unit': { body: { stayId: 's1', unitId: U101.id, version: 3 } } }),
      );
      const user = userEvent.setup();
      render(<ReservationDetail id={RES} />);
      const item = await stayItem();
      const select = within(item).getByRole('combobox', { name: 'Jedinica' });
      expect(select).toHaveValue('');
      await user.selectOptions(select, U101.id);
      await user.click(within(item).getByRole('button', { name: 'Dodeli' }));
      await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ unitId: U101.id, version: 2 });
    });

    it('version_conflict: the dictionary message, and the reservation is read again', async () => {
      const calls = mockFetch(
        moveRoutes(assigned, { 'POST /api/stays/s1/assign-unit': apiError(409, 'version_conflict', 'x', { version: 3 }) }),
      );
      const user = userEvent.setup();
      render(<ReservationDetail id={RES} />);
      const item = await stayItem();
      await user.selectOptions(within(item).getByRole('combobox', { name: 'Jedinica' }), U102.id);
      await user.click(within(item).getByRole('button', { name: 'Premesti' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Rezervaciju je u međuvremenu neko izmenio. Osvežite prikaz i pokušajte ponovo.',
      );
      await vi.waitFor(() => expect(calls.filter((c) => c.url === `/api/reservations/${RES}`)).toHaveLength(2));
      // The error stays visible after the reload.
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('a unit taken for those nights shows unit_taken', async () => {
      mockFetch(moveRoutes(assigned, { 'POST /api/stays/s1/assign-unit': apiError(409, 'unit_taken') }));
      const user = userEvent.setup();
      render(<ReservationDetail id={RES} />);
      const item = await stayItem();
      await user.selectOptions(within(item).getByRole('combobox', { name: 'Jedinica' }), U102.id);
      await user.click(within(item).getByRole('button', { name: 'Premesti' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Jedinica je već zauzeta u tom periodu.');
    });

    it('no unit select for a stay without a type, a cancelled stay, or a cancelled reservation', async () => {
      const untyped = { ...RESERVATION.stays[0], id: 's2', unitTypeId: null, unitId: U301.id, arrival: '2026-11-10', departure: '2026-11-11' };
      const cancelledStay = { ...RESERVATION.stays[0], id: 's3', unitId: U101.id, status: 'cancelled', arrival: '2026-11-12', departure: '2026-11-13' };
      mockFetch(moveRoutes({ ...assigned, stays: [assigned.stays[0], untyped, cancelledStay] }));
      render(<ReservationDetail id={RES} />);
      // Control: the typed, live stay has one.
      expect(within(await stayItem()).getByRole('combobox', { name: 'Jedinica' })).toBeInTheDocument();
      expect(
        within(screen.getByRole('listitem', { name: 'Boravak 10.11.2026 – 11.11.2026' })).queryByRole('combobox'),
      ).toBeNull();
      expect(
        within(screen.getByRole('listitem', { name: 'Boravak 12.11.2026 – 13.11.2026' })).queryByRole('combobox'),
      ).toBeNull();
    });

    it('a cancelled reservation offers no move', async () => {
      mockFetch(moveRoutes({ ...assigned, status: 'cancelled' }));
      render(<ReservationDetail id={RES} />);
      const item = await stayItem();
      expect(within(item).queryByRole('combobox')).toBeNull();
    });

    it('in safe mode the select and the button are disabled', async () => {
      mockFetch(moveRoutes(assigned, {}, 'EXPIRED'));
      render(<ReservationDetail id={RES} />);
      const item = await stayItem();
      await vi.waitFor(() => expect(within(item).getByRole('combobox', { name: 'Jedinica' })).toBeDisabled());
      expect(within(item).getByRole('button', { name: 'Premesti' })).toBeDisabled();
    });
  });

  it('in safe mode cancelling is disabled; the reservation is still shown', async () => {
    mockFetch(routes('EXPIRED'));
    render(<ReservationDetail id={RES} />);
    expect(await screen.findByText('28.10.2026 – 3.11.2026')).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Otkaži rezervaciju' })).toBeDisabled());
  });
});

describe('ReservationDetail: check-in, check-out, guests and mail', () => {
  it('offers Prijavi gosta on the arrival day of the open business day and checks in with the read version', async () => {
    const calls = mockFetch(
      routes('VALID', { [`POST /api/stays/s1/check-in`]: { body: { stayId: 's1', status: 'in_house', version: 3 } } }),
    );
    const user = userEvent.setup();
    render(<ReservationDetail id={RES} />);
    await user.click(await screen.findByRole('button', { name: 'Prijavi gosta' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Gost je prijavljen.');
    expect(calls.find((c) => c.method === 'POST')).toEqual({ method: 'POST', url: '/api/stays/s1/check-in', body: { version: 2 } });
    // The page was read again.
    expect(calls.filter((c) => c.url === `/api/reservations/${RES}`)).toHaveLength(2);
  });

  it('without an open business day check-in is not offered', async () => {
    mockFetch(routes('VALID', { 'GET /api/business-day': apiError(500, 'unknown') }));
    render(<ReservationDetail id={RES} />);
    expect(await screen.findByText('28.10.2026 – 3.11.2026')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prijavi gosta' })).toBeNull();
  });

  it('shows the guests of the stay, the mail history and a focusable heading', async () => {
    const withGuest = {
      ...RESERVATION,
      stays: [
        {
          ...RESERVATION.stays[0],
          guests: [{ id: 'g1', firstName: 'Ana', lastName: 'Anić', email: null, phone: null, language: 'sr', note: null, isPrimary: true }],
        },
      ],
    };
    mockFetch(
      routes('VALID', {
        [`GET /api/reservations/${RES}`]: { body: withGuest },
        [`GET /api/reservations/${RES}/messages`]: {
          body: [{ id: 'm1', template: 'reservation_confirmed', recipient: 'a@example.com', status: 'sent', attempts: 1, lastError: null, nextAttemptAt: null, sentAt: null, history: [] }],
        },
      }),
    );
    render(<ReservationDetail id={RES} />);
    expect(await screen.findByRole('listitem', { name: 'Ana Anić' })).toHaveTextContent('Nosilac');
    expect(await screen.findByText('Poslato')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveAttribute('tabindex', '-1');
  });
});

describe('ReservationDetail: licence modes on the stay actions', () => {
  const live = (status: string) => ({
    [`GET /api/reservations/${RES}`]: { body: { ...RESERVATION, stays: [{ ...RESERVATION.stays[0], status }] } },
  });

  it('EXPIRED (safe mode): Odjavi gosta works, Dodaj gosta does not', async () => {
    mockFetch(routes('EXPIRED', live('in_house')));
    render(<ReservationDetail id={RES} />);
    // The licence answers after the page: wait for a control that follows it.
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Dodaj gosta' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Odjavi gosta' })).toBeEnabled();
  });

  it('EXPIRED (safe mode): Prijavi gosta is disabled', async () => {
    mockFetch(routes('EXPIRED'));
    render(<ReservationDetail id={RES} />);
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Prijavi gosta' })).toBeDisabled());
  });

  it.each(['INVALID', 'NOT_ACTIVATED'])('%s: Odjavi gosta is disabled too', async (state) => {
    mockFetch(routes(state, live('in_house')));
    render(<ReservationDetail id={RES} />);
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Odjavi gosta' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Dodaj gosta' })).toBeDisabled();
  });

  it('a valid licence leaves Prijavi gosta enabled', async () => {
    mockFetch(routes('VALID'));
    render(<ReservationDetail id={RES} />);
    expect(await screen.findByRole('button', { name: 'Prijavi gosta' })).toBeEnabled();
  });
});
