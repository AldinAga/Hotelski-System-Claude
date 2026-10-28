import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '@/lib/api';
import { apiError, mockFetch, type Call } from '@/test/fetch-mock';
import NewReservationPage from './page';

const TYPE = { id: '11111111-1111-4111-8111-111111111111', code: 'DBL', name: { sr: 'Dvokrevetna' }, capacity: 2, beds: null, description: null, active: true };
const UNIT = { id: '22222222-2222-4222-8222-222222222222', name: 'Soba 101', unitTypeId: TYPE.id, address: null, municipality: null, eturistaObjectId: null, active: true, cleanliness: 'clean' };
const PLAN = { id: '44444444-4444-4444-8444-444444444444', code: 'BAR', name: { sr: 'Osnovni' }, board: 'BB', cancellationPolicy: null, discount7Pct: 0, discount30Pct: 0, active: true };
const RES = '55555555-5555-4555-8555-555555555555';

const QUOTE = {
  stays: [
    {
      nights: [
        { day: '2026-12-01', priceMinor: 1_000_000 },
        { day: '2026-12-02', priceMinor: 1_000_000 },
      ],
      totalMinor: 2_000_000,
    },
  ],
  totalMinor: 2_000_000,
};

function routes(extra: Record<string, unknown> = {}, state = 'VALID') {
  return {
    'GET /api/licence': { body: { activated: true, modules: ['hotel.core'], limits: {}, state } },
    'GET /api/unit-types': { body: [TYPE] },
    'GET /api/units': { body: [UNIT] },
    'GET /api/rate-plans': { body: [PLAN] },
    'POST /api/reservations/quote': { body: QUOTE },
    ...extra,
  } as Parameters<typeof mockFetch>[0];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T10:00:00+01:00'));
  vi.spyOn(navigation, 'go').mockImplementation(() => undefined);
  window.history.replaceState(null, '', '/rezervacije/nova');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  const form = await screen.findByRole('form', { name: 'Nova rezervacija' });
  const f = within(form);
  await user.type(f.getByLabelText('Ime'), 'Petar');
  await user.type(f.getByLabelText('Prezime'), 'Petrović');
  await user.clear(f.getByLabelText('Dolazak'));
  await user.type(f.getByLabelText('Dolazak'), '2026-12-01');
  await user.clear(f.getByLabelText('Odlazak'));
  await user.type(f.getByLabelText('Odlazak'), '2026-12-03');
  await user.selectOptions(f.getByLabelText('Smeštaj'), `type:${TYPE.id}`);
  return form;
}

const EXPECTED_BODY = {
  source: 'front_desk',
  holder: { firstName: 'Petar', lastName: 'Petrović' },
  stays: [{ unitTypeId: TYPE.id, arrival: '2026-12-01', departure: '2026-12-03', adults: 2, children: 0, ratePlanId: PLAN.id }],
};

describe('/rezervacije/nova', () => {
  it('shows the quote before confirming, then books and opens the reservation', async () => {
    const calls = mockFetch(
      routes({ 'POST /api/reservations': { status: 201, body: { reservationId: RES, number: 'R-2026-000001' } } }),
    );
    const user = userEvent.setup();
    render(<NewReservationPage />);
    const form = await fillForm(user);
    expect(within(form).queryByRole('button', { name: 'Potvrdi rezervaciju' })).toBeNull();

    await user.click(within(form).getByRole('button', { name: 'Izračunaj cenu' }));
    expect(await screen.findByText('Ukupno: 20.000,00 RSD')).toBeInTheDocument();
    expect(screen.getByText('1.12.2026')).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/api/reservations/quote')?.body).toEqual(EXPECTED_BODY);

    await user.click(screen.getByRole('button', { name: 'Potvrdi rezervaciju' }));
    await vi.waitFor(() => expect(navigation.go).toHaveBeenCalledWith(`/rezervacije/${RES}`));
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/reservations')?.body).toEqual(EXPECTED_BODY);
  });

  it('409 no_availability prikazuje poruku sa datumom i ne zatvara formu', async () => {
    mockFetch(routes({ 'POST /api/reservations': apiError(409, 'no_availability', 'server text', { day: '2026-12-02' }) }));
    const user = userEvent.setup();
    render(<NewReservationPage />);
    const form = await fillForm(user);
    await user.click(within(form).getByRole('button', { name: 'Izračunaj cenu' }));
    await user.click(await screen.findByRole('button', { name: 'Potvrdi rezervaciju' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Nema slobodnih jedinica za 2.12.2026.');
    expect(navigation.go).not.toHaveBeenCalled();
    expect(screen.getByRole('form', { name: 'Nova rezervacija' })).toBeInTheDocument();
    expect(within(form).getByLabelText('Ime')).toHaveValue('Petar');
    expect(within(form).getByLabelText('Dolazak')).toHaveValue('2026-12-01');
  });

  it('a quote refused for a date shows the message with that date', async () => {
    mockFetch(routes({ 'POST /api/reservations/quote': apiError(422, 'price_missing', 'x', { day: '2026-12-02', stay: 0 }) }));
    const user = userEvent.setup();
    render(<NewReservationPage />);
    const form = await fillForm(user);
    await user.click(within(form).getByRole('button', { name: 'Izračunaj cenu' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Za 2.12.2026 nije uneta cena.');
    expect(screen.queryByRole('button', { name: 'Potvrdi rezervaciju' })).toBeNull();
  });

  it('changing the form after a quote asks for a new quote before confirming', async () => {
    mockFetch(routes());
    const user = userEvent.setup();
    render(<NewReservationPage />);
    const form = await fillForm(user);
    await user.click(within(form).getByRole('button', { name: 'Izračunaj cenu' }));
    await screen.findByRole('button', { name: 'Potvrdi rezervaciju' });
    await user.clear(within(form).getByLabelText('Odrasli'));
    await user.type(within(form).getByLabelText('Odrasli'), '3');
    expect(screen.queryByRole('button', { name: 'Potvrdi rezervaciju' })).toBeNull();
  });

  it('opened from a calendar cell: the unit and arrival are filled in, departure is the next day', async () => {
    window.history.replaceState(null, '', `/rezervacije/nova?unitId=${UNIT.id}&arrival=2026-12-05`);
    const calls = mockFetch(routes());
    const user = userEvent.setup();
    render(<NewReservationPage />);
    const form = await screen.findByRole('form', { name: 'Nova rezervacija' });
    await vi.waitFor(() => expect(within(form).getByLabelText('Smeštaj')).toHaveValue(`unit:${UNIT.id}`));
    expect(within(form).getByLabelText('Dolazak')).toHaveValue('2026-12-05');
    expect(within(form).getByLabelText('Odlazak')).toHaveValue('2026-12-06');
    await user.type(within(form).getByLabelText('Ime'), 'Ana');
    await user.type(within(form).getByLabelText('Prezime'), 'Anić');
    await user.click(within(form).getByRole('button', { name: 'Izračunaj cenu' }));
    await vi.waitFor(() => expect(calls.some((c: Call) => c.url === '/api/reservations/quote')).toBe(true));
    expect((calls.find((c) => c.url === '/api/reservations/quote')?.body as typeof EXPECTED_BODY).stays[0]).toMatchObject({
      unitId: UNIT.id,
      arrival: '2026-12-05',
      departure: '2026-12-06',
    });
  });

  it('in safe mode the price can be checked but not confirmed', async () => {
    mockFetch(routes({}, 'EXPIRED'));
    const user = userEvent.setup();
    render(<NewReservationPage />);
    const form = await fillForm(user);
    await user.click(within(form).getByRole('button', { name: 'Izračunaj cenu' }));
    await screen.findByText('Ukupno: 20.000,00 RSD');
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Potvrdi rezervaciju' })).toBeDisabled());
  });
});
