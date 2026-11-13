import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockFetch } from '@/test/fetch-mock';
import type { CheckOutPreview, Reservation, ReservationStay } from '@/lib/types';
import type { LicenceMode } from '@/lib/use-read-only';
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

function setup(
  over: {
    stay?: Partial<ReservationStay>;
    businessDate?: string | null;
    licence?: LicenceMode;
    reservation?: Partial<Reservation>;
    /** The calendar date and how far the business day lags behind it (GET /business-day). */
    today?: string | null;
    lagDays?: number;
  } = {},
) {
  const onChanged = vi.fn();
  const ui = (licence: LicenceMode) => (
    <StayActions
      stay={{ ...STAY, ...over.stay }}
      reservation={{ ...RESERVATION, ...over.reservation }}
      businessDate={over.businessDate === undefined ? DAY : over.businessDate}
      today={over.today ?? null}
      lagDays={over.lagDays ?? 0}
      licence={licence}
      onChanged={onChanged}
    />
  );
  const view = render(ui(over.licence ?? 'full'));
  return { onChanged, ...view, setLicence: (licence: LicenceMode) => view.rerender(ui(licence)) };
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
    setup({ licence: 'safe' });
    expect(screen.getByRole('button', { name: 'Prijavi gosta' })).toBeDisabled();
  });

  it('without a usable licence (INVALID, NOT_ACTIVATED) Prijavi gosta is disabled', () => {
    setup({ licence: 'none' });
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
    const out = setup({ stay: inHouse, licence: 'safe' });
    await open(user);
    expect(screen.getByRole('button', { name: 'Potvrdi odjavu' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Potvrdi odjavu' }));
    await waitFor(() => expect(out.onChanged).toHaveBeenCalledWith('Gost je odjavljen.'));
    expect(calls.some((c) => c.method === 'POST')).toBe(true);
    out.unmount();

    setup({ licence: 'safe' });
    expect(screen.getByRole('button', { name: 'Prijavi gosta' })).toBeDisabled();
  });

  it('without a usable licence (INVALID, NOT_ACTIVATED) Odjavi gosta is disabled, and so is a confirmation already open', async () => {
    mockFetch({ 'GET /api/stays/s1/check-out-preview': { body: PREVIEW } });
    const user = userEvent.setup();
    const out = setup({ stay: inHouse, licence: 'none' });
    expect(screen.getByRole('button', { name: 'Odjavi gosta' })).toBeDisabled();
    out.setLicence('full');
    await open(user);
    out.setLicence('none');
    expect(screen.getByRole('button', { name: 'Potvrdi odjavu' })).toBeDisabled();
  });

  it('offers no check-out for a stay that is not in the house', () => {
    setup({ stay: { status: 'checked_out' } });
    expect(screen.queryByRole('button', { name: 'Odjavi gosta' })).toBeNull();
  });
});

describe('StayActions: a business day that was not closed (W2)', () => {
  // The open day is 12.11., the calendar says 13.11.: yesterday was never closed.
  const LATE = { businessDate: DAY, today: '2026-11-13', lagDays: 1 };
  const ARRIVES_TODAY = { stay: { arrival: '2026-11-13', departure: '2026-11-15' } };
  const REASON = 'Poslovni dan 12.11.2026 nije zatvoren. Zatvorite dan da biste prijavili gosta.';

  it('a guest arriving today gets the reason and a link to the business-day screen, not a bare date', () => {
    const { container } = setup({ ...LATE, ...ARRIVES_TODAY });
    expect(screen.queryByRole('button', { name: 'Prijavi gosta' })).toBeNull();
    expect(container).toHaveTextContent(REASON);
    expect(screen.getByRole('link', { name: 'Zatvorite dan' })).toHaveAttribute('href', '/poslovni-dan');
    expect(screen.queryByText(/^Dolazak/)).toBeNull();
  });

  it('with the business day on time the guest can be checked in and no reason shows (lag 0)', () => {
    const { container } = setup({ businessDate: DAY, today: DAY, lagDays: 0 });
    expect(screen.getByRole('button', { name: 'Prijavi gosta' })).toBeEnabled();
    expect(container).not.toHaveTextContent('nije zatvoren');
  });

  it('the lag the API reports decides: lag 0 says nothing, whatever the dates look like', () => {
    const { container } = setup({ businessDate: DAY, today: '2026-11-13', lagDays: 0, ...ARRIVES_TODAY });
    expect(container).not.toHaveTextContent('nije zatvoren');
    expect(screen.getByText('Dolazak 13.11.')).toBeInTheDocument();
  });

  it('after an evening close (lag below 0) the guest of the new day is checked in and nothing is said about a late day', () => {
    const { container } = setup({ businessDate: '2026-11-13', today: DAY, lagDays: -1, stay: { arrival: '2026-11-13' } });
    expect(screen.getByRole('button', { name: 'Prijavi gosta' })).toBeEnabled();
    expect(container).not.toHaveTextContent('nije zatvoren');
  });

  it('a guest arriving after today only gets the date, also while the day is late', () => {
    const { container } = setup({ ...LATE, stay: { arrival: '2026-11-14' } });
    expect(screen.getByText('Dolazak 14.11.')).toBeInTheDocument();
    expect(container).not.toHaveTextContent('nije zatvoren');
  });

  it('in safe mode the reason says check-in is not possible and still links to closing the day', () => {
    const { container } = setup({ ...LATE, ...ARRIVES_TODAY, licence: 'safe' });
    expect(container).toHaveTextContent(
      'Poslovni dan 12.11.2026 nije zatvoren. Licenca je istekla, pa prijava gosta nije moguća. Dan možete zatvoriti na ekranu Poslovni dan.',
    );
    expect(screen.getByRole('link', { name: 'Poslovni dan' })).toHaveAttribute('href', '/poslovni-dan');
  });

  it('without a usable licence the reason has no link, because the day cannot be closed either', () => {
    const { container } = setup({ ...LATE, ...ARRIVES_TODAY, licence: 'none' });
    expect(container).toHaveTextContent('Poslovni dan 12.11.2026 nije zatvoren. Licenca nije ispravna, pa prijava gosta nije moguća.');
    expect(screen.queryByRole('link')).toBeNull();
  });

  describe('the check-out preview', () => {
    // Leaving today (13.11.) while 12.11. is open: the API keeps the stay until 12.11. and gives night 12.11. back.
    const LOSES_A_NIGHT = {
      ...PREVIEW,
      businessDate: DAY,
      earlyDeparture: true,
      keptUntil: DAY,
      nightsToPost: [],
      nightsToRelease: ['2026-11-12'],
    };
    const inHouseStay = { stay: { ...inHouse, arrival: '2026-11-10', departure: '2026-11-13' } };
    const checkOutRoutes = (preview: unknown) => ({
      'GET /api/stays/s1/check-out-preview': { body: preview },
      'POST /api/stays/s1/check-out': { body: { stayId: 's1', status: 'checked_out', version: 5, departure: DAY } },
    });
    const open = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: 'Odjavi gosta' }));
      return screen.findByRole('region', { name: 'Pregled odjave' });
    };

    it('names the night that will not be charged, links to closing the day and wants a second confirmation', async () => {
      const calls = mockFetch(checkOutRoutes(LOSES_A_NIGHT));
      const user = userEvent.setup();
      const { onChanged } = setup({ ...LATE, ...inHouseStay });
      const panel = await open(user);
      expect(panel).toHaveTextContent('Noć 12.11.2026 neće biti naplaćena jer poslovni dan 12.11.2026 nije zatvoren.');
      expect(within(panel).getByRole('link', { name: 'Zatvorite dan' })).toHaveAttribute('href', '/poslovni-dan');
      const confirm = within(panel).getByRole('button', { name: 'Potvrdi odjavu' });
      expect(confirm).toBeDisabled();
      await user.click(within(panel).getByRole('checkbox', { name: 'Razumem da noć neće biti naplaćena i odjavljujem gosta.' }));
      expect(confirm).toBeEnabled();
      await user.click(confirm);
      await waitFor(() => expect(onChanged).toHaveBeenCalledWith('Gost je odjavljen.'));
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    });

    it('the confirmation can be taken back, and it is asked again for the next preview', async () => {
      mockFetch(checkOutRoutes(LOSES_A_NIGHT));
      const user = userEvent.setup();
      setup({ ...LATE, ...inHouseStay });
      let panel = await open(user);
      const box = within(panel).getByRole('checkbox');
      await user.click(box);
      await user.click(box);
      expect(within(panel).getByRole('button', { name: 'Potvrdi odjavu' })).toBeDisabled();
      await user.click(box);
      await user.click(within(panel).getByRole('button', { name: 'Odustani' }));
      panel = await open(user);
      expect(within(panel).getByRole('checkbox')).not.toBeChecked();
      expect(within(panel).getByRole('button', { name: 'Potvrdi odjavu' })).toBeDisabled();
    });

    it('says nights in the plural when more than one is lost', async () => {
      mockFetch(
        checkOutRoutes({ ...LOSES_A_NIGHT, businessDate: '2026-11-11', keptUntil: '2026-11-11', nightsToRelease: ['2026-11-11', '2026-11-12'] }),
      );
      const user = userEvent.setup();
      setup({ businessDate: '2026-11-11', today: '2026-11-13', lagDays: 2, stay: { ...inHouse, arrival: '2026-11-09', departure: '2026-11-13' } });
      const panel = await open(user);
      expect(panel).toHaveTextContent('Noći 11.11.2026, 12.11.2026 neće biti naplaćene jer poslovni dan 11.11.2026 nije zatvoren.');
      expect(within(panel).getByRole('checkbox', { name: 'Razumem da noći neće biti naplaćene i odjavljujem gosta.' })).toBeInTheDocument();
    });

    it('with the day on time an early departure is a real one: no warning and one click confirms (lag 0)', async () => {
      mockFetch(checkOutRoutes({ ...LOSES_A_NIGHT, nightsToRelease: ['2026-11-14'], keptUntil: '2026-11-14' }));
      const user = userEvent.setup();
      setup({ businessDate: DAY, today: DAY, lagDays: 0, ...inHouseStay });
      const panel = await open(user);
      expect(panel).not.toHaveTextContent('nije zatvoren');
      expect(within(panel).queryByRole('checkbox')).toBeNull();
      expect(within(panel).getByRole('button', { name: 'Potvrdi odjavu' })).toBeEnabled();
    });

    it('a day that is late but a night that is released after today is a real early departure: no warning', async () => {
      mockFetch(checkOutRoutes({ ...LOSES_A_NIGHT, nightsToRelease: ['2026-11-14'] }));
      const user = userEvent.setup();
      setup({ ...LATE, ...inHouseStay });
      const panel = await open(user);
      expect(panel).not.toHaveTextContent('neće biti naplaćen');
      expect(within(panel).queryByRole('checkbox')).toBeNull();
    });

    it('after an evening close (lag below 0) there is no warning', async () => {
      mockFetch(checkOutRoutes({ ...LOSES_A_NIGHT, businessDate: '2026-11-13', keptUntil: '2026-11-13', nightsToRelease: ['2026-11-14'] }));
      const user = userEvent.setup();
      setup({ businessDate: '2026-11-13', today: DAY, lagDays: -1, ...inHouseStay });
      const panel = await open(user);
      expect(panel).not.toHaveTextContent('neće biti naplaćen');
      expect(within(panel).queryByRole('checkbox')).toBeNull();
    });

    it('in safe mode the link is still offered, because closing the day is allowed there', async () => {
      mockFetch(checkOutRoutes(LOSES_A_NIGHT));
      const user = userEvent.setup();
      setup({ ...LATE, ...inHouseStay, licence: 'safe' });
      const panel = await open(user);
      expect(within(panel).getByRole('link', { name: 'Zatvorite dan' })).toHaveAttribute('href', '/poslovni-dan');
      expect(within(panel).getByRole('checkbox')).toBeInTheDocument();
    });
  });
});
