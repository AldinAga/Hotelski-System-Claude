import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '@/lib/api';
import { apiError, mockFetch, type Call } from '@/test/fetch-mock';
import UnitsPage from './page';

const TYPE = { id: '11111111-1111-4111-8111-111111111111', code: 'DBL', name: { sr: 'Dvokrevetna' }, capacity: 2, beds: '1 bračni', description: null, active: true };
const UNIT = { id: '22222222-2222-4222-8222-222222222222', name: 'Soba 101', unitTypeId: TYPE.id, address: null, municipality: null, eturistaObjectId: null, active: true, cleanliness: 'clean' };
const BLOCK_ID = '55555555-5555-4555-8555-555555555555';
const CALENDAR = {
  days: [],
  availability: [],
  unassigned: [],
  units: [
    {
      id: UNIT.id,
      name: UNIT.name,
      unitTypeId: TYPE.id,
      cleanliness: 'clean',
      bars: [
        { kind: 'stay', stayId: 's', reservationId: 'r', number: 'R-1', guest: 'Gost', arrival: '2026-11-02', departure: '2026-11-04', status: 'booked' },
        { kind: 'block', blockId: BLOCK_ID, from: '2026-11-10', to: '2026-11-12', reason: 'maintenance' },
      ],
    },
  ],
};

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /api/unit-types': { body: [TYPE] },
    'GET /api/units': { body: [UNIT] },
    'GET /api/calendar': { body: CALENDAR },
    ...extra,
  } as Parameters<typeof mockFetch>[0];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T10:00:00+01:00'));
  vi.spyOn(navigation, 'go').mockImplementation(() => undefined);
  window.history.replaceState(null, '', '/podesavanja/jedinice');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('/podesavanja/jedinice', () => {
  it('lists types, units and their blocks (read from the calendar)', async () => {
    const calls = mockFetch(routes());
    render(<UnitsPage />);
    const unitRow = await screen.findByRole('listitem', { name: 'Soba 101' });
    expect(unitRow).toHaveTextContent('DBL – Dvokrevetna');
    expect(within(unitRow).getByText('10.11.2026 – 11.11.2026 · Održavanje')).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'DBL – Dvokrevetna' })).toHaveTextContent('2 osobe');
    expect(calls.find((c) => c.url.startsWith('/api/calendar'))?.url).toBe('/api/calendar?from=2026-11-01&to=2027-01-02');
  });

  it('deactivation refused with 409 unit_has_blocks shows the dictionary message', async () => {
    const calls = mockFetch(
      routes({ [`PATCH /api/units/${UNIT.id}`]: apiError(409, 'unit_has_blocks', 'server text', { blockId: BLOCK_ID }) }),
    );
    const user = userEvent.setup();
    render(<UnitsPage />);
    const unitRow = await screen.findByRole('listitem', { name: 'Soba 101' });
    await user.click(within(unitRow).getByRole('button', { name: 'Isključi' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Jedinica ima blokadu koja još traje. Prvo uklonite blokadu, pa ponovo pokušajte.',
    );
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ active: false });
  });

  it('adds a block with the last night inclusive in the form and exclusive in the request', async () => {
    const calls = mockFetch(
      routes({
        [`POST /api/units/${UNIT.id}/blocks`]: (c: Call) => ({ status: 201, body: { id: 'b2', unitId: UNIT.id, ...(c.body as object) } }),
      }),
    );
    const user = userEvent.setup();
    render(<UnitsPage />);
    const unitRow = await screen.findByRole('listitem', { name: 'Soba 101' });
    await user.click(within(unitRow).getByRole('button', { name: 'Dodaj blokadu' }));
    const form = within(unitRow).getByRole('form', { name: 'Nova blokada za Soba 101' });
    await user.type(within(form).getByLabelText('Prva noć'), '2026-11-20');
    await user.type(within(form).getByLabelText('Poslednja noć'), '2026-11-22');
    await user.selectOptions(within(form).getByLabelText('Razlog'), 'owner_use');
    await user.click(within(form).getByRole('button', { name: 'Sačuvaj blokadu' }));

    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      url: `/api/units/${UNIT.id}/blocks`,
      body: { from: '2026-11-20', to: '2026-11-23', reason: 'owner_use' },
    });
  });

  it('removes a block with DELETE', async () => {
    const calls = mockFetch(routes({ [`DELETE /api/units/${UNIT.id}/blocks/${BLOCK_ID}`]: { status: 204 } }));
    const user = userEvent.setup();
    render(<UnitsPage />);
    const unitRow = await screen.findByRole('listitem', { name: 'Soba 101' });
    await user.click(within(unitRow).getByRole('button', { name: 'Ukloni blokadu 10.11.2026 – 11.11.2026' }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  it('a block beyond the first 62 days becomes visible after moving "Blokade od"', async () => {
    const FAR = '66666666-6666-4666-8666-666666666666';
    const calls = mockFetch(
      routes({
        'GET /api/calendar': (c: Call) => ({
          body: c.url.includes('from=2027-03-01')
            ? {
                ...CALENDAR,
                units: [
                  { ...CALENDAR.units[0], bars: [{ kind: 'block', blockId: FAR, from: '2027-03-10', to: '2027-03-12', reason: 'maintenance' }] },
                ],
              }
            : CALENDAR,
        }),
        [`DELETE /api/units/${UNIT.id}/blocks/${FAR}`]: { status: 204 },
      }),
    );
    const user = userEvent.setup();
    render(<UnitsPage />);
    await screen.findByRole('listitem', { name: 'Soba 101' });
    expect(screen.queryByText(/10\.3\.2027/)).toBeNull();

    fireEvent.change(screen.getByLabelText('Blokade od'), { target: { value: '2027-03-01' } });

    const unitRow = await screen.findByRole('listitem', { name: 'Soba 101' });
    expect(await within(unitRow).findByText('10.3.2027 – 11.3.2027 · Održavanje')).toBeInTheDocument();
    expect(calls.map((c) => c.url)).toContain('/api/calendar?from=2027-03-01&to=2027-05-02');
    await user.click(within(unitRow).getByRole('button', { name: 'Ukloni blokadu 10.3.2027 – 11.3.2027' }));
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url === `/api/units/${UNIT.id}/blocks/${FAR}`)).toBe(true),
    );
  });

  it('unit_has_blocks offers removing the named block, even one outside the window, and sends the DELETE', async () => {
    const FAR = '77777777-7777-4777-8777-777777777777';
    const calls = mockFetch(
      routes({
        [`PATCH /api/units/${UNIT.id}`]: apiError(409, 'unit_has_blocks', 'server text', { blockId: FAR }),
        [`DELETE /api/units/${UNIT.id}/blocks/${FAR}`]: { status: 204 },
      }),
    );
    const user = userEvent.setup();
    render(<UnitsPage />);
    const unitRow = await screen.findByRole('listitem', { name: 'Soba 101' });
    await user.click(within(unitRow).getByRole('button', { name: 'Isključi' }));

    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Ukloni tu blokadu' }));

    await vi.waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([`/api/units/${UNIT.id}/blocks/${FAR}`]);
    expect(await screen.findByRole('status')).toHaveTextContent('Blokada je uklonjena.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a refused unit create keeps the typed name; a successful one clears it', async () => {
    let refuse = true;
    mockFetch(
      routes({
        'POST /api/units': (c: Call) =>
          refuse
            ? apiError(409, 'unit_name_taken')
            : { status: 201, body: { ...UNIT, id: 'n', ...(c.body as object) } },
      }),
    );
    const user = userEvent.setup();
    render(<UnitsPage />);
    const form = await screen.findByRole('form', { name: 'Nova jedinica' });
    await user.type(within(form).getByLabelText('Naziv'), 'Soba 101');
    await user.click(within(form).getByRole('button', { name: 'Dodaj jedinicu' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Jedinica sa ovim nazivom već postoji.');
    expect(within(form).getByLabelText('Naziv')).toHaveValue('Soba 101');

    refuse = false;
    await user.click(within(form).getByRole('button', { name: 'Dodaj jedinicu' }));
    await vi.waitFor(() => expect(within(form).getByLabelText('Naziv')).toHaveValue(''));
  });

  it('creates a unit type', async () => {
    const calls = mockFetch(routes({ 'POST /api/unit-types': (c: Call) => ({ status: 201, body: { ...TYPE, id: 'x', ...(c.body as object) } }) }));
    const user = userEvent.setup();
    render(<UnitsPage />);
    const form = await screen.findByRole('form', { name: 'Novi tip jedinice' });
    await user.type(within(form).getByLabelText('Oznaka'), 'SGL');
    await user.type(within(form).getByLabelText('Naziv'), 'Jednokrevetna');
    await user.clear(within(form).getByLabelText('Kapacitet (osoba)'));
    await user.type(within(form).getByLabelText('Kapacitet (osoba)'), '1');
    await user.click(within(form).getByRole('button', { name: 'Dodaj tip' }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ code: 'SGL', name: { sr: 'Jednokrevetna' }, capacity: 1 });
  });
});
