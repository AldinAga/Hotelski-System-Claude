import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockFetch } from '@/test/fetch-mock';
import type { CheckOutPreview, Reservation, ReservationStay } from '@/lib/types';
import { StayActions } from './stay-actions';

const DAY = '2026-11-12';

const STAY: ReservationStay = {
  id: 's1',
  unitTypeId: 't1',
  unitId: 'u1',
  arrival: DAY,
  departure: '2026-11-15',
  adults: 2,
  children: 0,
  ratePlanId: 'p1',
  status: 'expected',
  nights: [],
  totalMinor: 0,
  guests: [],
};

const RESERVATION = { id: 'r1', number: 'R-2026-000001', status: 'confirmed', version: 4 } as Reservation;

const PREVIEW: CheckOutPreview = {
  businessDate: DAY,
  keptUntil: '2026-11-15',
  earlyDeparture: false,
  nightsToPost: [{ night: '2026-11-14', priceMinor: 1_000_000 }],
  nightsToRelease: [],
  balanceMinor: 0,
};

function setup(over: { stay?: Partial<ReservationStay>; businessDate?: string | null; readOnly?: boolean } = {}) {
  const onChanged = vi.fn();
  const view = render(
    <StayActions
      stay={{ ...STAY, ...over.stay }}
      reservation={RESERVATION}
      businessDate={over.businessDate === undefined ? DAY : over.businessDate}
      readOnly={over.readOnly ?? false}
      onChanged={onChanged}
    />,
  );
  return { onChanged, ...view };
}

const inHouse = { status: 'in_house' as const };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StayActions: check-in', () => {
  it('offers Prijavi gosta only for an expected stay arriving on the business day', () => {
    const { unmount } = setup();
    expect(screen.getByRole('button', { name: 'Prijavi gosta' })).toBeEnabled();
    unmount();

    // Arrives later: no button, the day instead.
    const later = setup({ stay: { arrival: '2026-11-13' } });
    expect(screen.queryByRole('button', { name: 'Prijavi gosta' })).toBeNull();
    expect(screen.getByText('Dolazak 13.11.')).toBeInTheDocument();
    later.unmount();

    // Arrival already behind the business day: nothing.
    const earlier = setup({ stay: { arrival: '2026-11-11' } });
    expect(screen.queryByRole('button', { name: 'Prijavi gosta' })).toBeNull();
    expect(screen.queryByText(/Dolazak/)).toBeNull();
    earlier.unmount();

    // Not expected any more, or the business day is not known.
    const here = setup({ stay: inHouse });
    expect(screen.queryByRole('button', { name: 'Prijavi gosta' })).toBeNull();
    here.unmount();
    setup({ businessDate: null });
    expect(screen.queryByRole('button', { name: 'Prijavi gosta' })).toBeNull();
  });

  it('checks in with the reservation version the server gave and reports it', async () => {
    const calls = mockFetch({ 'POST /api/stays/s1/check-in': { body: { stayId: 's1', status: 'in_house', version: 5 } } });
    const user = userEvent.setup();
    const { onChanged } = setup();
    await user.click(screen.getByRole('button', { name: 'Prijavi gosta' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('Gost je prijavljen.'));
    expect(calls).toEqual([{ method: 'POST', url: '/api/stays/s1/check-in', body: { version: 4 } }]);
  });

  it('409 check_in_wrong_day names both dates and says to close the business day, then reads the page again', async () => {
    mockFetch({
      'POST /api/stays/s1/check-in': apiError(409, 'check_in_wrong_day', 'x', { arrival: '2026-11-12', businessDate: '2026-11-11' }),
    });
    const user = userEvent.setup();
    const { onChanged } = setup();
    await user.click(screen.getByRole('button', { name: 'Prijavi gosta' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Dolazak je 12.11.2026, a poslovni dan je 11.11.2026. Zatvorite poslovni dan pre prijave gosta.',
    );
    expect(onChanged).toHaveBeenCalledWith();
  });

  it('a stale reservation version shows the dictionary message and reads the page again', async () => {
    mockFetch({ 'POST /api/stays/s1/check-in': apiError(409, 'version_conflict', 'x', { version: 5 }) });
    const user = userEvent.setup();
    const { onChanged } = setup();
    await user.click(screen.getByRole('button', { name: 'Prijavi gosta' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Rezervaciju je u međuvremenu neko izmenio. Osvežite prikaz i pokušajte ponovo.',
    );
    expect(onChanged).toHaveBeenCalledWith();
  });

  it('a stay without a unit shows unit_required', async () => {
    mockFetch({ 'POST /api/stays/s1/check-in': apiError(422, 'unit_required') });
    const user = userEvent.setup();
    setup({ stay: { unitId: null } });
    await user.click(screen.getByRole('button', { name: 'Prijavi gosta' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Prvo dodelite jedinicu boravku.');
  });

  it('a double click on Prijavi gosta sends one request', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = mockFetch({
      'POST /api/stays/s1/check-in': async () => {
        await gate;
        return { body: { stayId: 's1', status: 'in_house', version: 5 } };
      },
    });
    const user = userEvent.setup();
    const { onChanged } = setup();
    await user.dblClick(screen.getByRole('button', { name: 'Prijavi gosta' }));
    expect(screen.getByRole('button', { name: 'Prijavi gosta' })).toBeDisabled();
    release();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('in safe mode Prijavi gosta is disabled', () => {
    setup({ readOnly: true });
    expect(screen.getByRole('button', { name: 'Prijavi gosta' })).toBeDisabled();
  });
});

describe('StayActions: check-out', () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'Odjavi gosta' }));
    return screen.findByRole('region', { name: 'Pregled odjave' });
  };

  it('shows the nights it posts and the balance, and confirms with the reservation version', async () => {
    const calls = mockFetch({
      'GET /api/stays/s1/check-out-preview': { body: PREVIEW },
      'POST /api/stays/s1/check-out': { body: { stayId: 's1', status: 'checked_out', version: 5, departure: '2026-11-15' } },
    });
    const user = userEvent.setup();
    const { onChanged } = setup({ stay: inHouse });
    const panel = await open(user);
    expect(panel).toHaveTextContent('Noći koje se knjiže');
    expect(panel).toHaveTextContent('14.11.2026');
    expect(panel).toHaveTextContent('10.000,00 RSD');
    expect(panel).toHaveTextContent('Saldo: 0,00 RSD');
    expect(panel).not.toHaveTextContent('Rani odlazak');
    expect(screen.queryByRole('link', { name: 'Folio' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Potvrdi odjavu' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('Gost je odjavljen.'));
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', url: '/api/stays/s1/check-out', body: { version: 4 } },
    ]);
    expect(screen.queryByRole('region', { name: 'Pregled odjave' })).toBeNull();
  });

  it('a balance of 5.000,00 shows the link to the folio and no Potvrdi odjavu', async () => {
    mockFetch({ 'GET /api/stays/s1/check-out-preview': { body: { ...PREVIEW, balanceMinor: 500_000 } } });
    const user = userEvent.setup();
    setup({ stay: inHouse });
    const panel = await open(user);
    expect(panel).toHaveTextContent('Saldo: 5.000,00 RSD');
    expect(screen.getByRole('link', { name: 'Folio' })).toHaveAttribute('href', '/folio/s1');
    expect(screen.queryByRole('button', { name: 'Potvrdi odjavu' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Odustani' })).toBeEnabled();
  });

  it('an early departure names the nights that are given back', async () => {
    mockFetch({
      'GET /api/stays/s1/check-out-preview': {
        body: {
          ...PREVIEW,
          earlyDeparture: true,
          keptUntil: '2026-11-13',
          nightsToPost: [],
          nightsToRelease: ['2026-11-13', '2026-11-14'],
        },
      },
    });
    const user = userEvent.setup();
    setup({ stay: inHouse });
    const panel = await open(user);
    expect(panel).toHaveTextContent(
      'Rani odlazak: boravak se završava 13.11.2026. Noći koje se oslobađaju: 13.11.2026, 14.11.2026.',
    );
    expect(panel).toHaveTextContent('Nema noći za knjiženje.');
  });

  it('a double click on Potvrdi odjavu sends one request', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = mockFetch({
      'GET /api/stays/s1/check-out-preview': { body: PREVIEW },
      'POST /api/stays/s1/check-out': async () => {
        await gate;
        return { body: { stayId: 's1', status: 'checked_out', version: 5, departure: '2026-11-15' } };
      },
    });
    const user = userEvent.setup();
    const { onChanged } = setup({ stay: inHouse });
    await open(user);
    await user.dblClick(screen.getByRole('button', { name: 'Potvrdi odjavu' }));
    release();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('two clicks in the same tick (before the button is disabled) still send one request', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = mockFetch({
      'GET /api/stays/s1/check-out-preview': { body: PREVIEW },
      'POST /api/stays/s1/check-out': async () => {
        await gate;
        return { body: { stayId: 's1', status: 'checked_out', version: 5, departure: '2026-11-15' } };
      },
    });
    const user = userEvent.setup();
    const { onChanged } = setup({ stay: inHouse });
    await open(user);
    const confirm = screen.getByRole('button', { name: 'Potvrdi odjavu' });
    act(() => {
      confirm.click();
      confirm.click();
    });
    release();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('409 version_conflict on confirming shows the message, closes the preview and reads the page again', async () => {
    mockFetch({
      'GET /api/stays/s1/check-out-preview': { body: PREVIEW },
      'POST /api/stays/s1/check-out': apiError(409, 'version_conflict', 'x', { version: 5 }),
    });
    const user = userEvent.setup();
    const { onChanged } = setup({ stay: inHouse });
    await open(user);
    await user.click(screen.getByRole('button', { name: 'Potvrdi odjavu' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Rezervaciju je u međuvremenu neko izmenio.');
    expect(onChanged).toHaveBeenCalledWith();
    expect(screen.queryByRole('region', { name: 'Pregled odjave' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Odjavi gosta' })).toBeEnabled());
  });

  it('folio_balance_open from the server shows the amount', async () => {
    mockFetch({
      'GET /api/stays/s1/check-out-preview': { body: PREVIEW },
      'POST /api/stays/s1/check-out': apiError(409, 'folio_balance_open', 'x', { balanceMinor: 500_000 }),
    });
    const user = userEvent.setup();
    setup({ stay: inHouse });
    await open(user);
    await user.click(screen.getByRole('button', { name: 'Potvrdi odjavu' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Saldo folija nije nula (5.000,00 RSD). Naplatite ili vratite razliku pre odjave.',
    );
  });

  it('a failed preview shows the message and no panel', async () => {
    mockFetch({ 'GET /api/stays/s1/check-out-preview': apiError(409, 'stay_not_in_house', 'x', { status: 'checked_out' }) });
    const user = userEvent.setup();
    setup({ stay: inHouse });
    await user.click(screen.getByRole('button', { name: 'Odjavi gosta' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Odjaviti se može samo gost koji je prijavljen.');
    expect(screen.queryByRole('region', { name: 'Pregled odjave' })).toBeNull();
  });

  it('opening the preview moves focus to it and Odustani gives focus back to Odjavi gosta', async () => {
    mockFetch({ 'GET /api/stays/s1/check-out-preview': { body: PREVIEW } });
    const user = userEvent.setup();
    setup({ stay: inHouse });
    await open(user);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Pregled odjave' })).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Odustani' }));
    expect(screen.queryByRole('region', { name: 'Pregled odjave' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Odjavi gosta' })).toHaveFocus());
  });

  it('in safe mode Odjavi gosta works and Prijavi gosta is disabled', async () => {
    const calls = mockFetch({
      'GET /api/stays/s1/check-out-preview': { body: PREVIEW },
      'POST /api/stays/s1/check-out': { body: { stayId: 's1', status: 'checked_out', version: 5, departure: '2026-11-15' } },
    });
    const user = userEvent.setup();
    const out = setup({ stay: inHouse, readOnly: true });
    await open(user);
    expect(screen.getByRole('button', { name: 'Potvrdi odjavu' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Potvrdi odjavu' }));
    await waitFor(() => expect(out.onChanged).toHaveBeenCalledWith('Gost je odjavljen.'));
    expect(calls.some((c) => c.method === 'POST')).toBe(true);
    out.unmount();

    setup({ readOnly: true });
    expect(screen.getByRole('button', { name: 'Prijavi gosta' })).toBeDisabled();
  });

  it('offers no check-out for a stay that is not in the house', () => {
    setup({ stay: { status: 'checked_out' } });
    expect(screen.queryByRole('button', { name: 'Odjavi gosta' })).toBeNull();
  });
});
