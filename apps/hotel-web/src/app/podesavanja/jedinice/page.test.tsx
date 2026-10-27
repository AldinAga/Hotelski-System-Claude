import { render, screen, within } from '@testing-library/react';
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
