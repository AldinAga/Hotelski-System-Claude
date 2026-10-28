import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '@/lib/api';
import { apiError, mockFetch, type Call, type Reply } from '@/test/fetch-mock';
import RatesPage from './page';

const TYPE = { id: '11111111-1111-4111-8111-111111111111', code: 'DBL', name: { sr: 'Dvokrevetna' }, capacity: 2, beds: null, description: null, active: true };
const TYPED_UNIT = { id: '22222222-2222-4222-8222-222222222222', name: 'Soba 101', unitTypeId: TYPE.id, address: null, municipality: null, eturistaObjectId: null, active: true, cleanliness: 'clean' };
const LOOSE_UNIT = { id: '33333333-3333-4333-8333-333333333333', name: 'Apartman 2', unitTypeId: null, address: null, municipality: null, eturistaObjectId: null, active: true, cleanliness: 'clean' };
const PLAN = { id: '44444444-4444-4444-8444-444444444444', code: 'BAR', name: { sr: 'Osnovni' }, board: 'BB', cancellationPolicy: null, discount7Pct: 0, discount30Pct: 0, active: true };

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/rate-plans': { body: [PLAN] },
    'GET /api/unit-types': { body: [TYPE] },
    'GET /api/units': { body: [TYPED_UNIT, LOOSE_UNIT] },
    [`GET /api/rate-plans/${PLAN.id}/days`]: { body: [{ day: '2026-11-02', priceMinor: 1_000_000, closed: false }] },
    [`PUT /api/rate-plans/${PLAN.id}/days`]: (c: Call) => ({ body: { days: 3, echo: c.body } }),
    ...extra,
  } as Parameters<typeof mockFetch>[0];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T10:00:00+01:00'));
  vi.spyOn(navigation, 'go').mockImplementation(() => undefined);
  window.history.replaceState(null, '', '/podesavanja/cene');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT');

describe('/podesavanja/cene', () => {
  it('mreža cena šalje jedan PUT za izabrani opseg dana', async () => {
    const calls = mockFetch(routes());
    const user = userEvent.setup();
    render(<RatesPage />);

    // The stored price is shown in its cell.
    expect(await screen.findByRole('button', { name: /^2026-11-02, 10\.000,00 RSD/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^2026-11-03/ }));
    await user.click(screen.getByRole('button', { name: /^2026-11-05/ }));
    expect(screen.getByText('Izabrano: 3.11.2026 – 5.11.2026 (3 noći)')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Cena po noći (RSD)'), '5500');
    await user.click(screen.getByRole('button', { name: 'Postavi cenu' }));

    await vi.waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]).toEqual({
      method: 'PUT',
      url: `/api/rate-plans/${PLAN.id}/days`,
      body: { scope: { kind: 'unit_type', id: TYPE.id }, from: '2026-11-03', to: '2026-11-06', priceMinor: 550_000 },
    });
    // The grid is read again after the change.
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.method === 'GET' && c.url.includes('/days')).length).toBeGreaterThanOrEqual(2),
    );
    // Still exactly one write after the grid has settled: no per-day requests.
    expect(puts(calls)).toHaveLength(1);
    expect(await screen.findByRole('status')).toHaveTextContent('Cena 5.500,00 RSD je postavljena za 3 noći.');
    const get = calls.find((c) => c.url.includes('/days'))!;
    expect(get.url).toBe(
      `/api/rate-plans/${PLAN.id}/days?scope=unit_type%3A${TYPE.id}&from=2026-11-01&to=2026-12-02`,
    );
  });

  it('a range picked backwards is sent in day order; closing sends closed only', async () => {
    const calls = mockFetch(routes());
    const user = userEvent.setup();
    render(<RatesPage />);

    await user.click(await screen.findByRole('button', { name: /^2026-11-10/ }));
    await user.click(screen.getByRole('button', { name: /^2026-11-08/ }));
    await user.click(screen.getByRole('button', { name: 'Zatvori dane' }));

    await vi.waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toEqual({
      scope: { kind: 'unit_type', id: TYPE.id },
      from: '2026-11-08',
      to: '2026-11-11',
      closed: true,
    });
  });

  it('offers unit types and untyped units only, and never a way to clear a price', async () => {
    mockFetch(routes());
    render(<RatesPage />);
    const scope = await screen.findByLabelText('Za koga važi cena');
    const options = within(scope).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Tip: DBL – Dvokrevetna', 'Jedinica bez tipa: Apartman 2']);
    expect(screen.queryByRole('button', { name: /obriši|ukloni cenu/i })).toBeNull();
    expect(screen.getByText(/Uneta cena se ne može obrisati/)).toBeInTheDocument();
  });

  describe('out-of-order grid answers', () => {
    const DAYS = `GET /api/rate-plans/${PLAN.id}/days`;
    const isType = (c: Call) => c.url.includes(`scope=unit_type%3A${TYPE.id}`);
    const looseDays = { body: [{ day: '2026-11-02', priceMinor: 200_000, closed: false }] };

    function deferred() {
      let resolve!: (r: Reply) => void;
      const promise = new Promise<Reply>((r) => (resolve = r));
      return { promise, resolve };
    }

    for (const [label, late] of [
      ['prices', { body: [{ day: '2026-11-02', priceMinor: 1_000_000, closed: false }] }],
      ['an error', apiError(500, 'boom', 'Kasna greška.')],
    ] as Array<[string, Reply]>) {
      it(`a late answer with ${label} for a scope already left neither paints nor reports`, async () => {
        const slow = deferred();
        mockFetch(routes({ [DAYS]: (c: Call) => (isType(c) ? slow.promise : looseDays) }));
        const user = userEvent.setup();
        render(<RatesPage />);

        const scope = await screen.findByLabelText('Za koga važi cena');
        await user.selectOptions(scope, `unit:${LOOSE_UNIT.id}`);
        expect(await screen.findByRole('button', { name: /^2026-11-02, 2\.000,00 RSD/ })).toBeInTheDocument();

        slow.resolve(late);
        await new Promise((r) => setTimeout(r, 50));
        expect(screen.getByRole('button', { name: /^2026-11-02/ })).toHaveAccessibleName(/^2026-11-02, 2\.000,00 RSD/);
        expect(screen.queryByRole('alert')).toBeNull();
      });
    }

    it('while another scope loads, the previous scope\'s prices are not shown', async () => {
      const slow = deferred();
      mockFetch(
        routes({
          [DAYS]: (c: Call) =>
            isType(c) ? { body: [{ day: '2026-11-02', priceMinor: 1_000_000, closed: false }] } : slow.promise,
        }),
      );
      const user = userEvent.setup();
      render(<RatesPage />);
      await screen.findByRole('button', { name: /^2026-11-02, 10\.000,00 RSD/ });

      await user.selectOptions(screen.getByLabelText('Za koga važi cena'), `unit:${LOOSE_UNIT.id}`);
      expect(screen.getByRole('button', { name: /^2026-11-02/ })).toHaveAccessibleName('2026-11-02, bez cene');
      slow.resolve(looseDays);
      expect(await screen.findByRole('button', { name: /^2026-11-02, 2\.000,00 RSD/ })).toBeInTheDocument();
    });

    it('a load error goes away after a later successful load', async () => {
      mockFetch(routes({ [DAYS]: (c: Call) => (isType(c) ? apiError(500, 'boom', 'Greška pri čitanju.') : looseDays) }));
      const user = userEvent.setup();
      render(<RatesPage />);
      expect(await screen.findByRole('alert')).toHaveTextContent('Greška pri čitanju.');

      await user.selectOptions(screen.getByLabelText('Za koga važi cena'), `unit:${LOOSE_UNIT.id}`);
      expect(await screen.findByRole('button', { name: /^2026-11-02, 2\.000,00 RSD/ })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('shows the safe-mode refusal from the dictionary', async () => {
    mockFetch(routes({ [`PUT /api/rate-plans/${PLAN.id}/days`]: apiError(403, 'safe_mode_blocked', 'server text') }));
    const user = userEvent.setup();
    render(<RatesPage />);
    await user.click(await screen.findByRole('button', { name: /^2026-11-03/ }));
    await user.type(screen.getByLabelText('Cena po noći (RSD)'), '100');
    await user.click(screen.getByRole('button', { name: 'Postavi cenu' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sistem radi u sigurnom režimu');
  });

  describe('roles (the API changes prices for owner and manager only)', () => {
    const me = (role: string) => ({ 'GET /api/auth/me': { body: { id: 'u', email: 'x@hotel.test', name: 'X', role } } });
    const changeControls = () => [
      screen.queryByRole('button', { name: 'Postavi cenu' }),
      screen.queryByRole('button', { name: 'Zatvori dane' }),
      screen.queryByRole('button', { name: 'Otvori dane' }),
      screen.queryByRole('button', { name: 'Isključi' }),
      screen.queryByRole('form', { name: 'Novi cenovnik' }),
    ];

    it('a manager gets the change controls', async () => {
      mockFetch(routes(me('manager')));
      render(<RatesPage />);
      await screen.findByRole('button', { name: /^2026-11-02, 10\.000,00 RSD/ });
      await vi.waitFor(() => expect(changeControls().every((c) => c !== null)).toBe(true));
    });

    for (const role of ['receptionist', 'housekeeping']) {
      it(`${role} sees the prices but no change controls`, async () => {
        const calls = mockFetch(routes(me(role)));
        render(<RatesPage />);
        expect(await screen.findByRole('button', { name: /^2026-11-02, 10\.000,00 RSD/ })).toBeInTheDocument();
        await vi.waitFor(() => expect(changeControls()).toEqual([null, null, null, null, null]));
        expect(screen.getByText('Cene menja vlasnik ili menadžer.')).toBeInTheDocument();
        expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
      });
    }
  });
});
