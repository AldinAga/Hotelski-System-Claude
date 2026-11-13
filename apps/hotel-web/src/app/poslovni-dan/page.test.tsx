import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/components/app-shell';
import { navigation } from '@/lib/api';
import type { AuditReport, BusinessDayView, ClosedDaySummary } from '@/lib/business';
import { apiError, mockFetch, type Call } from '@/test/fetch-mock';
import BusinessDayLayout from './layout';
import BusinessDayPage from './page';

// The open day (2 November) is not the calendar day (3 November) and not the
// computer's day either: a close that sends any other day than the shown one fails.
const VIEW: BusinessDayView = {
  day: '2026-11-02',
  today: '2026-11-03',
  started: true,
  lagDays: 1,
  lastClosed: { day: '2026-11-01', closedAt: '2026-11-01T22:30:00.000Z', mode: 'manual' },
  lastAutoError: null,
  blockers: [],
  // inHouse (all guests now) differs from nightsToPost on purpose: the dialog must use the latter.
  pending: { arrivals: 2, departures: 1, inHouse: 9, nightsToPost: 4, noShows: 1 },
};

const REPORT: AuditReport = {
  day: '2026-11-02',
  mode: 'manual',
  closedAt: '2026-11-02T23:30:00.000Z',
  closedBy: 'u1',
  arrivals: 2,
  departures: 1,
  inHouse: 3,
  noShows: [{ stayId: 's9', number: 'R-2026-000009', guest: 'Marko Marković', arrival: '2026-11-02', chargedMinor: 500_000 }],
  roomRevenueMinor: 1_500_000,
  chargesByKindMinor: { accommodation: 2_000_000, correction: -500_000 },
  paymentsByMethodMinor: { cash: 1_000_000, card: 250_000 },
  postedNights: 4,
};

const CLOSED: ClosedDaySummary[] = [
  { day: '2026-10-30', closedAt: '2026-10-30T22:00:00.000Z', mode: 'auto', roomRevenueMinor: 700_000, noShows: 0 },
  { day: '2026-11-01', closedAt: '2026-11-01T22:30:00.000Z', mode: 'manual', roomRevenueMinor: 900_000, noShows: 2 },
];

function view(over: Partial<BusinessDayView> = {}): BusinessDayView {
  return { ...VIEW, ...over };
}

type Route = Parameters<typeof mockFetch>[0][string];

/**
 * GET /business-day answers views[0] until the close was posted, then views[1]
 * (the last one for every later read): the day moves on only after a close.
 */
function setup(views: BusinessDayView[], extra: Record<string, Route> = {}, state = 'VALID', role = 'owner') {
  let closes = 0;
  const close = extra['POST /api/business-day/close'];
  return mockFetch({
    'GET /api/licence': { body: { activated: true, modules: ['hotel.core', 'hotel.folio'], limits: {}, state } },
    'GET /api/auth/me': { body: { role } },
    'GET /api/business-day': () => ({ body: views[Math.min(closes, views.length - 1)] }),
    'GET /api/business-days': { body: CLOSED },
    ...extra,
    ...(close === undefined
      ? {}
      : {
          'POST /api/business-day/close': async (call: Call) => {
            try {
              return typeof close === 'function' ? await close(call) : close;
            } finally {
              closes++;
            }
          },
        }),
  });
}

const closeButton = () => screen.getByRole('button', { name: /^Zatvori dan/ });
const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');

beforeEach(() => {
  vi.spyOn(navigation, 'go').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Poslovni dan: the open day', () => {
  it('shows the open day big, today, the counts and the labelled sections', async () => {
    setup([VIEW]);
    render(<BusinessDayPage />);
    const hero = await screen.findByRole('region', { name: 'Otvoreni poslovni dan' });
    expect(within(hero).getByText('2.11.2026')).toBeInTheDocument();
    expect(within(hero).getByText('Danas je 3.11.2026.')).toBeInTheDocument();
    expect(within(hero).getByText(/Poslednji zatvoren dan: 1.11.2026 \(ručno, 23:30\)/)).toBeInTheDocument();
    const pending = screen.getByRole('region', { name: 'Stanje otvorenog dana' });
    const figure = (label: string) => within(pending).getByText(label).nextElementSibling;
    expect(figure('Prijave na ovaj dan')).toHaveTextContent('2');
    expect(figure('Odjave na ovaj dan')).toHaveTextContent('1');
    expect(figure('Gosti u objektu sada')).toHaveTextContent('9');
    expect(figure('Noći za knjiženje')).toHaveTextContent('4');
    expect(figure('Gosti koji nisu došli')).toHaveTextContent('1');
  });

  it('kašnjenje od 1 dana prikazuje upozorenje i oznaku u meniju', async () => {
    setup([VIEW]);
    render(
      <AppShell>
        <BusinessDayPage />
      </AppShell>,
    );
    expect(await screen.findByText('Poslovni dan kasni 1 dan. Zatvorite dan 2.11. da biste prijavljivali današnje goste.')).toBeInTheDocument();
    const badge = await screen.findByText(/^Poslovni dan: 2\.11\./);
    expect(badge).toHaveAttribute('data-late', 'true');
    expect(badge).toHaveClass('is-late');
    expect(badge).toHaveTextContent('kasni 1 dan');
  });

  it('a lag of several days says "dana"', async () => {
    setup([view({ lagDays: 3 })]);
    render(<BusinessDayPage />);
    expect(await screen.findByText(/^Poslovni dan kasni 3 dana\./)).toBeInTheDocument();
  });

  it.each([0, -1])('lagDays %i is no lag: no warning and a plain badge', async (lagDays) => {
    setup([view({ lagDays })]);
    render(
      <AppShell>
        <BusinessDayPage />
      </AppShell>,
    );
    const badge = await screen.findByText(/^Poslovni dan: 2\.11\./);
    expect(badge).toHaveAttribute('data-late', 'false');
    expect(badge).not.toHaveClass('is-late');
    expect(screen.queryByText(/kasni/)).toBeNull();
  });

  it('shows the failed automatic close with the reason in words', async () => {
    setup([view({ lastAutoError: { at: '2026-11-03T01:00:00.000Z', code: 'close_failed', details: { stayId: 's1', night: '2026-11-02' } } })]);
    render(<BusinessDayPage />);
    expect(await screen.findByText(/Automatsko zatvaranje nije uspelo \(3\.11\.2026 u 02:00\): Noćenje nije moglo da se proknjiži/)).toBeInTheDocument();
  });

  it('shows a failed read as a message', async () => {
    setup([VIEW], { 'GET /api/business-day': apiError(500, 'unknown') });
    render(<BusinessDayPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Došlo je do greške. Pokušajte ponovo.');
    expect(screen.queryByRole('button', { name: /^Zatvori dan/ })).toBeNull();
  });
});

describe('Poslovni dan: blockers and when closing is possible', () => {
  const BLOCKER = { stayId: 's2', reservationId: 'r-22', number: 'R-2026-000022', unitName: 'Soba 12', departure: '2026-11-02' };

  it('blokada prikazuje gosta sa linkom i onemogućava zatvaranje', async () => {
    setup([view({ blockers: [BLOCKER] })]);
    render(<BusinessDayPage />);
    const section = await screen.findByRole('region', { name: 'Gosti koji još nisu odjavljeni' });
    expect(within(section).getByRole('link', { name: 'Rezervacija R-2026-000022' })).toHaveAttribute('href', '/rezervacije/r-22');
    expect(within(section).getByText('Soba 12')).toBeInTheDocument();
    expect(within(section).getByText('odlazak 2.11.2026')).toBeInTheDocument();
    expect(closeButton()).toBeDisabled();
  });

  it('without blockers the button is "Zatvori dan 2.11." and enabled', async () => {
    setup([VIEW]);
    render(<BusinessDayPage />);
    expect(await screen.findByRole('button', { name: 'Zatvori dan 2.11.' })).toBeEnabled();
    expect(screen.queryByRole('region', { name: 'Gosti koji još nisu odjavljeni' })).toBeNull();
  });

  it('the button is disabled while the open day is after today, and says why', async () => {
    setup([view({ day: '2026-11-04', lagDays: -1 })]);
    render(<BusinessDayPage />);
    expect(await screen.findByText('Dan 4.11.2026 još nije počeo, pa ne može da se zatvori.')).toBeInTheDocument();
    expect(closeButton()).toBeDisabled();
  });

  it('safe mode still closes the day; no usable licence does not', async () => {
    setup([VIEW], {}, 'EXPIRED');
    const safe = render(<BusinessDayPage />);
    await screen.findByRole('button', { name: 'Zatvori dan 2.11.' });
    await vi.waitFor(() => expect(closeButton()).toBeEnabled());
    safe.unmount();

    setup([VIEW], {}, 'INVALID');
    render(<BusinessDayPage />);
    await screen.findByRole('button', { name: 'Zatvori dan 2.11.' });
    await vi.waitFor(() => expect(closeButton()).toBeDisabled());
  });
});

describe('Poslovni dan: the confirmation and the close', () => {
  it('the dialog is labelled, states the server counts, takes the focus and gives it back on Odustani', async () => {
    setup([VIEW]);
    const user = userEvent.setup();
    render(<BusinessDayPage />);
    await user.click(await screen.findByRole('button', { name: 'Zatvori dan 2.11.' }));

    const dialog = screen.getByRole('dialog', { name: 'Zatvaranje dana 2.11.2026' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // 4 nights and 1 no-show come from pending.nightsToPost and pending.noShows, not from pending.inHouse (9).
    expect(dialog).toHaveTextContent('Proknjižiće se 4 noći.');
    expect(dialog).toHaveTextContent('Za 1 gost se beleži „nije došao“.');
    expect(within(dialog).getByRole('heading', { name: 'Zatvaranje dana 2.11.2026' })).toHaveFocus();

    await user.click(within(dialog).getByRole('button', { name: 'Odustani' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Zatvori dan 2.11.' })).toHaveFocus();
  });

  it('Escape cancels without sending anything and returns the focus', async () => {
    const calls = setup([VIEW]);
    const user = userEvent.setup();
    render(<BusinessDayPage />);
    await user.click(await screen.findByRole('button', { name: 'Zatvori dan 2.11.' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Zatvori dan 2.11.' })).toHaveFocus();
    expect(posts(calls)).toHaveLength(0);
  });

  it('Escape does nothing while the close is on its way', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    setup([VIEW], {
      'POST /api/business-day/close': async () => {
        await gate;
        return { body: { alreadyClosed: false, report: REPORT } };
      },
    });
    const user = userEvent.setup();
    render(<BusinessDayPage />);
    await user.click(await screen.findByRole('button', { name: 'Zatvori dan 2.11.' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Potvrdi zatvaranje' }));
    // The focused button is off now, so the key goes to the dialog itself.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    release();
    await screen.findByRole('heading', { name: 'Izveštaj za dan 2.11.2026' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Tab stays inside the dialog, both ways round', async () => {
    setup([VIEW]);
    const user = userEvent.setup();
    render(<BusinessDayPage />);
    await user.click(await screen.findByRole('button', { name: 'Zatvori dan 2.11.' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Potvrdi zatvaranje' });
    const cancel = within(dialog).getByRole('button', { name: 'Odustani' });

    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();
  });

  it('zatvaranje šalje dan koji je prikazan i posle prikazuje izveštaj', async () => {
    const calls = setup([VIEW, view({ day: '2026-11-03', lagDays: 0, pending: { ...VIEW.pending, nightsToPost: 0, noShows: 0 } })], {
      'POST /api/business-day/close': { body: { alreadyClosed: false, report: REPORT } },
    });
    const user = userEvent.setup();
    render(
      <AppShell>
        <BusinessDayPage />
      </AppShell>,
    );
    expect(await screen.findByText(/^Poslovni dan: 2\.11\./)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Zatvori dan 2.11.' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Potvrdi zatvaranje' }));

    const heading = await screen.findByRole('heading', { name: 'Izveštaj za dan 2.11.2026' });
    expect(posts(calls)).toEqual([{ method: 'POST', url: '/api/business-day/close', body: { day: '2026-11-02' } }]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Dan 2.11.2026 je zatvoren.')).toBeInTheDocument();
    // The report moves the focus to its heading.
    expect(heading).toHaveFocus();

    const report = screen.getByRole('region', { name: 'Izveštaj za dan 2.11.2026' });
    expect(within(report).getByText('Zatvoren ručno 3.11.2026 u 00:30')).toBeInTheDocument();
    const figure = (label: string) => within(report).getByText(label).nextElementSibling;
    expect(figure('Prijave')).toHaveTextContent('2');
    expect(figure('Odjave')).toHaveTextContent('1');
    // The report's inHouse counts the nights the close posted; its label says so.
    expect(figure('Gosti kojima je noć proknjižena')).toHaveTextContent('3');
    expect(figure('Proknjižene noći')).toHaveTextContent('4');
    expect(figure('Prihod od smeštaja')).toHaveTextContent('15.000,00 RSD');
    expect(within(report).getByText('R-2026-000009')).toBeInTheDocument();
    expect(within(report).getByText('Naplaćeno 5.000,00 RSD')).toBeInTheDocument();
    const kinds = within(report).getByRole('region', { name: 'Stavke po vrsti' });
    expect(within(kinds).getByText('Smeštaj').nextElementSibling).toHaveTextContent('20.000,00 RSD');
    expect(within(kinds).getByText('Ispravka').nextElementSibling).toHaveTextContent('-5.000,00 RSD');
    const methods = within(report).getByRole('region', { name: 'Plaćanja po načinu' });
    expect(within(methods).getByText('Gotovina').nextElementSibling).toHaveTextContent('10.000,00 RSD');
    expect(within(methods).getByText('Kartica').nextElementSibling).toHaveTextContent('2.500,00 RSD');

    // The page and the menu badge read the new open day.
    expect(await screen.findByRole('button', { name: 'Zatvori dan 3.11.' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/^Poslovni dan: 3\.11\./)).toBeInTheDocument());
  });

  it('alreadyClosed prikazuje sačuvan izveštaj bez greške', async () => {
    setup([VIEW], { 'POST /api/business-day/close': { body: { alreadyClosed: true, report: REPORT } } });
    const user = userEvent.setup();
    render(<BusinessDayPage />);
    await user.click(await screen.findByRole('button', { name: 'Zatvori dan 2.11.' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Potvrdi zatvaranje' }));

    expect(await screen.findByRole('heading', { name: 'Izveštaj za dan 2.11.2026' })).toBeInTheDocument();
    expect(screen.getByText('Dan 2.11.2026 je već bio zatvoren. Prikazan je sačuvan izveštaj.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('business_day_in_future prikazuje poruku sa danima kao D.M.YYYY i čita stanje ponovo', async () => {
    const calls = setup([VIEW, VIEW], {
      'POST /api/business-day/close': apiError(409, 'business_day_in_future', 'x', { day: '2026-11-03', today: '2026-11-02' }),
    });
    const user = userEvent.setup();
    render(<BusinessDayPage />);
    await user.click(await screen.findByRole('button', { name: 'Zatvori dan 2.11.' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Potvrdi zatvaranje' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Poslovni dan 3.11.2026 još nije počeo (danas je 2.11.2026) i ne može da se zatvori.');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/business-day')).toHaveLength(2));
    expect(screen.queryByRole('heading', { name: /^Izveštaj/ })).toBeNull();
  });

  it('business_day_mismatch names the open day, reads the state again and shows the new day', async () => {
    const calls = setup([VIEW, view({ day: '2026-11-03', lagDays: 0 })], {
      'POST /api/business-day/close': apiError(409, 'business_day_mismatch', 'x', { open: '2026-11-03' }),
    });
    const user = userEvent.setup();
    render(<BusinessDayPage />);
    await user.click(await screen.findByRole('button', { name: 'Zatvori dan 2.11.' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Potvrdi zatvaranje' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Otvoren je drugi poslovni dan (3.11.2026). Osvežite prikaz.');
    expect(await screen.findByRole('button', { name: 'Zatvori dan 3.11.' })).toBeInTheDocument();
    expect(calls.filter((c) => c.url === '/api/business-day')).toHaveLength(2);
  });

  it('close_blocked shows the message and the blockers that appeared', async () => {
    const blocker = { stayId: 's2', reservationId: 'r-22', number: 'R-2026-000022', unitName: null, departure: '2026-11-02' };
    setup([VIEW, view({ blockers: [blocker] })], {
      'POST /api/business-day/close': apiError(409, 'close_blocked', 'x', { departures: [blocker] }),
    });
    const user = userEvent.setup();
    render(<BusinessDayPage />);
    await user.click(await screen.findByRole('button', { name: 'Zatvori dan 2.11.' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Potvrdi zatvaranje' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Gosti koji odlaze još nisu odjavljeni.');
    expect(await screen.findByRole('link', { name: 'Rezervacija R-2026-000022' })).toBeInTheDocument();
    expect(screen.getByText('Bez jedinice')).toBeInTheDocument();
    expect(closeButton()).toBeDisabled();
  });

  it('close_failed says the day stayed open', async () => {
    setup([VIEW, VIEW], {
      'POST /api/business-day/close': apiError(409, 'close_failed', 'x', { stayId: 's1', night: '2026-11-02' }),
    });
    const user = userEvent.setup();
    render(<BusinessDayPage />);
    await user.click(await screen.findByRole('button', { name: 'Zatvori dan 2.11.' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Potvrdi zatvaranje' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Noćenje nije moglo da se proknjiži, pa je dan ostao otvoren.');
  });

  it('a network error closes the dialog, keeps the state and allows another try', async () => {
    const calls = setup([VIEW], {
      'POST /api/business-day/close': () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const user = userEvent.setup();
    render(<BusinessDayPage />);
    await user.click(await screen.findByRole('button', { name: 'Zatvori dan 2.11.' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Potvrdi zatvaranje' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Not a 409: nothing was read again.
    expect(calls.filter((c) => c.url === '/api/business-day')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Zatvori dan 2.11.' })).toBeEnabled();
  });

  it('the confirmation is disabled while the request runs, and a double click sends one close', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = setup([VIEW], {
      'POST /api/business-day/close': async () => {
        await gate;
        return { body: { alreadyClosed: false, report: REPORT } };
      },
    });
    const user = userEvent.setup();
    render(<BusinessDayPage />);
    await user.click(await screen.findByRole('button', { name: 'Zatvori dan 2.11.' }));
    const dialog = screen.getByRole('dialog');
    await user.dblClick(within(dialog).getByRole('button', { name: 'Potvrdi zatvaranje' }));
    expect(within(dialog).getByRole('button', { name: 'Potvrdi zatvaranje' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Odustani' })).toBeDisabled();
    release();
    await screen.findByRole('heading', { name: 'Izveštaj za dan 2.11.2026' });
    expect(posts(calls)).toHaveLength(1);
  });

  it('two clicks in the same tick (before the button is disabled) still send one close', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = setup([VIEW], {
      'POST /api/business-day/close': async () => {
        await gate;
        return { body: { alreadyClosed: false, report: REPORT } };
      },
    });
    const user = userEvent.setup();
    render(<BusinessDayPage />);
    await user.click(await screen.findByRole('button', { name: 'Zatvori dan 2.11.' }));
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Potvrdi zatvaranje' });
    act(() => {
      confirm.click();
      confirm.click();
    });
    release();
    await screen.findByRole('heading', { name: 'Izveštaj za dan 2.11.2026' });
    expect(posts(calls)).toHaveLength(1);
  });
});

describe('Poslovni dan: closed days', () => {
  it('lists the 30 days before the open day, newest first, with their numbers', async () => {
    const calls = setup([VIEW]);
    render(<BusinessDayPage />);
    const list = await screen.findByRole('region', { name: 'Zatvoreni dani' });
    // Counted back from the day the server calls open, not from the computer's clock.
    await waitFor(() => expect(calls.some((c) => c.url === '/api/business-days?from=2026-10-03&to=2026-11-02')).toBe(true));
    const rows = await within(list).findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('1.11.2026');
    expect(rows[0]).toHaveTextContent('Ručno');
    expect(rows[0]).toHaveTextContent('Smeštaj 9.000,00 RSD · nisu došli: 2');
    expect(rows[1]).toHaveTextContent('30.10.2026');
    expect(rows[1]).toHaveTextContent('Automatski');
  });

  it('says so when no day was closed yet', async () => {
    setup([VIEW], { 'GET /api/business-days': { body: [] } });
    render(<BusinessDayPage />);
    expect(await screen.findByText('Još nema zatvorenih dana.')).toBeInTheDocument();
  });

  it('a failed list read is shown without hiding the open day', async () => {
    setup([VIEW], { 'GET /api/business-days': apiError(500, 'unknown') });
    render(<BusinessDayPage />);
    expect(await screen.findByRole('button', { name: 'Zatvori dan 2.11.' })).toBeInTheDocument();
    const list = await screen.findByRole('region', { name: 'Zatvoreni dani' });
    expect(await within(list).findByRole('alert')).toHaveTextContent('Došlo je do greške.');
  });

  it('opens the stored report of a closed day', async () => {
    const calls = setup([VIEW], {
      'GET /api/business-days/2026-11-01': { body: { day: '2026-11-01', closedAt: REPORT.closedAt, closedBy: 'u1', mode: 'manual', report: { ...REPORT, day: '2026-11-01' } } },
    });
    const user = userEvent.setup();
    render(<BusinessDayPage />);
    await user.click(await screen.findByRole('button', { name: 'Izveštaj za 1.11.2026' }));
    const heading = await screen.findByRole('heading', { name: 'Izveštaj za dan 1.11.2026' });
    expect(calls.some((c) => c.url === '/api/business-days/2026-11-01')).toBe(true);
    expect(heading).toHaveFocus();
  });

  it('an automatic close says so', async () => {
    setup([VIEW], {
      'GET /api/business-days/2026-10-30': { body: { day: '2026-10-30', closedAt: '2026-10-30T22:00:00.000Z', closedBy: null, mode: 'auto', report: { ...REPORT, day: '2026-10-30', mode: 'auto', closedAt: '2026-10-30T22:00:00.000Z', closedBy: null } } },
    });
    const user = userEvent.setup();
    render(<BusinessDayPage />);
    await user.click(await screen.findByRole('button', { name: 'Izveštaj za 30.10.2026' }));
    expect(await screen.findByText('Zatvoren automatski 30.10.2026 u 23:00')).toBeInTheDocument();
  });

  it('an empty report says so, shows a zero charge as "Bez naplate" and an unknown kind as it came', async () => {
    const quiet: AuditReport = {
      ...REPORT,
      day: '2026-11-01',
      noShows: [{ stayId: 's1', number: 'R-2026-000001', guest: 'Ana Anić', arrival: '2026-11-01', chargedMinor: 0 }],
      chargesByKindMinor: { gift: 100_000 },
      paymentsByMethodMinor: {},
    };
    setup([VIEW], {
      'GET /api/business-days/2026-11-01': { body: { day: '2026-11-01', closedAt: quiet.closedAt, closedBy: 'u1', mode: 'manual', report: quiet } },
      'GET /api/business-days/2026-10-30': { body: { day: '2026-10-30', closedAt: quiet.closedAt, closedBy: 'u1', mode: 'manual', report: { ...quiet, day: '2026-10-30', noShows: [], chargesByKindMinor: {} } } },
    });
    const user = userEvent.setup();
    render(<BusinessDayPage />);
    await user.click(await screen.findByRole('button', { name: 'Izveštaj za 1.11.2026' }));
    const report = await screen.findByRole('region', { name: 'Izveštaj za dan 1.11.2026' });
    expect(within(report).getByText('Bez naplate')).toBeInTheDocument();
    expect(within(report).getByText('gift').nextElementSibling).toHaveTextContent('1.000,00 RSD');
    expect(within(within(report).getByRole('region', { name: 'Plaćanja po načinu' })).getByText('Nema knjiženja.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Izveštaj za 30.10.2026' }));
    const empty = await screen.findByRole('region', { name: 'Izveštaj za dan 30.10.2026' });
    expect(within(empty).getByText('Nijedan gost.')).toBeInTheDocument();
    expect(within(within(empty).getByRole('region', { name: 'Stavke po vrsti' })).getByText('Nema knjiženja.')).toBeInTheDocument();
  });

  it('two clicks on a report in the same tick read it once, and the other reports wait', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = setup([VIEW], {
      'GET /api/business-days/2026-11-01': async () => {
        await gate;
        return { body: { day: '2026-11-01', closedAt: REPORT.closedAt, closedBy: 'u1', mode: 'manual', report: { ...REPORT, day: '2026-11-01' } } };
      },
    });
    render(<BusinessDayPage />);
    const first = await screen.findByRole('button', { name: 'Izveštaj za 1.11.2026' });
    act(() => {
      first.click();
      first.click();
    });
    expect(screen.getByRole('button', { name: 'Izveštaj za 30.10.2026' })).toBeDisabled();
    release();
    await screen.findByRole('heading', { name: 'Izveštaj za dan 1.11.2026' });
    expect(calls.filter((c) => c.url === '/api/business-days/2026-11-01')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Izveštaj za 30.10.2026' })).toBeEnabled();
  });

  it('a day that is gone shows the message', async () => {
    setup([VIEW], { 'GET /api/business-days/2026-11-01': apiError(404, 'business_day_not_found') });
    const user = userEvent.setup();
    render(<BusinessDayPage />);
    await user.click(await screen.findByRole('button', { name: 'Izveštaj za 1.11.2026' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Poslovni dan nije zatvoren ili ne postoji.');
  });
});

describe('Poslovni dan: layout', () => {
  it('the back-to-top button is part of the screen through its layout', async () => {
    setup([VIEW]);
    render(
      <BusinessDayLayout>
        <h1>Poslovni dan</h1>
      </BusinessDayLayout>,
    );
    expect(await screen.findByRole('link', { name: 'Poslovni dan' })).toHaveAttribute('href', '/poslovni-dan');
    expect(document.querySelector('.back-to-top--app')).not.toBeNull();
    await screen.findByText(/^Poslovni dan: 2\.11\./);
  });
});
