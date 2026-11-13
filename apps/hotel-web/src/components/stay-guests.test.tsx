import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { apiError, mockFetch } from '@/test/fetch-mock';
import type { ReservationStay, StayGuest } from '@/lib/types';
import { StayGuests } from './stay-guests';

const guest = (id: string, firstName: string, lastName: string, isPrimary = false, over: Partial<StayGuest> = {}): StayGuest => ({
  id,
  firstName,
  lastName,
  email: null,
  phone: null,
  language: 'sr',
  note: null,
  isPrimary,
  ...over,
});

const ANA = guest('g1', 'Ana', 'Anić', true, { email: 'ana@example.com' });
const BOJAN = guest('g2', 'Bojan', 'Bošković');
const CEDA = guest('g3', 'Čedomir', 'Čolić');

const STAY: ReservationStay = {
  id: 's1',
  unitTypeId: 't1',
  unitId: 'u1',
  arrival: '2026-11-12',
  departure: '2026-11-15',
  adults: 3,
  children: 0,
  ratePlanId: 'p1',
  status: 'expected',
  nights: [],
  totalMinor: 0,
  guests: [ANA, BOJAN],
};

const stayWith = (over: Partial<ReservationStay>): ReservationStay => ({ ...STAY, ...over });

describe('StayGuests', () => {
  it('lists the guests and marks only the primary one Nosilac', () => {
    render(<StayGuests stay={STAY} readOnly={false} />);
    const ana = screen.getByRole('listitem', { name: 'Ana Anić' });
    const bojan = screen.getByRole('listitem', { name: 'Bojan Bošković' });
    expect(within(ana).getByText('Nosilac')).toBeInTheDocument();
    expect(within(bojan).queryByText('Nosilac')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Gosti (2 od 3)' })).toBeInTheDocument();
    // The primary guest can be neither removed nor "made primary" again.
    expect(within(ana).queryByRole('button')).toBeNull();
    expect(within(bojan).getByRole('button', { name: 'Ukloni gosta Bojan Bošković' })).toBeEnabled();
  });

  it('Dodaj gosta is disabled when the stay is full (guests = adults + children)', () => {
    const { unmount } = render(<StayGuests stay={STAY} readOnly={false} />);
    expect(screen.getByRole('button', { name: 'Dodaj gosta' })).toBeEnabled();
    expect(screen.queryByText(/Boravak je pun/)).toBeNull();
    unmount();

    render(<StayGuests stay={stayWith({ adults: 1, children: 1 })} readOnly={false} />);
    expect(screen.getByRole('button', { name: 'Dodaj gosta' })).toBeDisabled();
    expect(screen.getByText('Boravak je pun: nema mesta za još jednog gosta.')).toBeInTheDocument();
  });

  it('in safe mode Dodaj gosta, Ukloni and Postavi kao nosioca are disabled', () => {
    render(<StayGuests stay={STAY} readOnly />);
    expect(screen.getByRole('button', { name: 'Dodaj gosta' })).toBeDisabled();
    const bojan = screen.getByRole('listitem', { name: 'Bojan Bošković' });
    expect(within(bojan).getByRole('button', { name: /Ukloni/ })).toBeDisabled();
    expect(within(bojan).getByRole('button', { name: /Postavi kao nosioca/ })).toBeDisabled();
  });

  it('a stay that is over cannot be changed: the list stays, the controls go', () => {
    render(<StayGuests stay={stayWith({ status: 'checked_out' })} readOnly={false} />);
    expect(screen.getByRole('listitem', { name: 'Bojan Bošković' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('finds a guest already on file and adds that one, leaving out guests already on the stay', async () => {
    const calls = mockFetch({
      'GET /api/guests': { body: [ANA, { ...CEDA, isPrimary: undefined }] },
      'POST /api/stays/s1/guests': { body: [ANA, BOJAN, CEDA] },
    });
    const user = userEvent.setup();
    render(<StayGuests stay={STAY} readOnly={false} />);
    await user.click(screen.getByRole('button', { name: 'Dodaj gosta' }));
    await user.type(screen.getByLabelText('Pretraga gostiju'), 'Č{enter}');
    const found = await screen.findByRole('list', { name: 'Pronađeni gosti' });
    expect(calls[0]).toEqual({ method: 'GET', url: `/api/guests?q=${encodeURIComponent('Č')}`, body: undefined });
    // Ana is on the stay already: not offered.
    expect(within(found).queryByRole('listitem', { name: 'Ana Anić' })).toBeNull();

    await user.click(within(found).getByRole('button', { name: 'Dodaj gosta Čedomir Čolić' }));
    expect(await screen.findByRole('listitem', { name: 'Čedomir Čolić' })).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      method: 'POST',
      url: '/api/stays/s1/guests',
      body: { guestId: 'g3' },
    });
    // The form closed, the count moved, and the stay is full now.
    expect(screen.queryByRole('region', { name: 'Dodavanje gosta' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Gosti (3 od 3)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dodaj gosta' })).toBeDisabled();
  });

  it('says so when nobody on file matches', async () => {
    mockFetch({ 'GET /api/guests': { body: [] } });
    const user = userEvent.setup();
    render(<StayGuests stay={STAY} readOnly={false} />);
    await user.click(screen.getByRole('button', { name: 'Dodaj gosta' }));
    await user.type(screen.getByLabelText('Pretraga gostiju'), 'Zzz{enter}');
    expect(await screen.findByText('Nema gostiju koji odgovaraju pretrazi.')).toBeInTheDocument();
  });

  it('adds a new guest with only the fields that were filled in', async () => {
    const calls = mockFetch({ 'POST /api/stays/s1/guests': { body: [ANA, BOJAN, CEDA] } });
    const user = userEvent.setup();
    render(<StayGuests stay={STAY} readOnly={false} />);
    await user.click(screen.getByRole('button', { name: 'Dodaj gosta' }));
    await user.type(screen.getByLabelText('Ime'), ' Čedomir ');
    await user.type(screen.getByLabelText('Prezime'), 'Čolić');
    await user.type(screen.getByLabelText('E-adresa'), 'ceda@example.com');
    await user.click(screen.getByRole('button', { name: 'Dodaj novog gosta' }));
    expect(await screen.findByRole('listitem', { name: 'Čedomir Čolić' })).toBeInTheDocument();
    expect(calls).toEqual([
      {
        method: 'POST',
        url: '/api/stays/s1/guests',
        body: { guest: { firstName: 'Čedomir', lastName: 'Čolić', email: 'ceda@example.com' } },
      },
    ]);
  });

  it('leaves out an e-mail and a phone that were not filled in', async () => {
    const calls = mockFetch({ 'POST /api/stays/s1/guests': { body: [ANA, BOJAN, CEDA] } });
    const user = userEvent.setup();
    render(<StayGuests stay={STAY} readOnly={false} />);
    await user.click(screen.getByRole('button', { name: 'Dodaj gosta' }));
    await user.type(screen.getByLabelText('Ime'), 'Čedomir');
    await user.type(screen.getByLabelText('Prezime'), 'Čolić');
    await user.click(screen.getByRole('button', { name: 'Dodaj novog gosta' }));
    await screen.findByRole('listitem', { name: 'Čedomir Čolić' });
    expect(calls[0].body).toEqual({ guest: { firstName: 'Čedomir', lastName: 'Čolić' } });
  });

  it('removes a guest who is not the primary one', async () => {
    const calls = mockFetch({ 'DELETE /api/stays/s1/guests/g2': { body: [ANA] } });
    const user = userEvent.setup();
    render(<StayGuests stay={STAY} readOnly={false} />);
    await user.click(screen.getByRole('button', { name: 'Ukloni gosta Bojan Bošković' }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Bojan Bošković' })).toBeNull());
    expect(calls).toEqual([{ method: 'DELETE', url: '/api/stays/s1/guests/g2', body: undefined }]);
    expect(screen.getByRole('heading', { name: 'Gosti (1 od 3)' })).toBeInTheDocument();
  });

  it('makes another guest the primary one and shows the new order', async () => {
    const calls = mockFetch({
      'POST /api/stays/s1/guests/g2/primary': { body: [{ ...BOJAN, isPrimary: true }, { ...ANA, isPrimary: false }] },
    });
    const user = userEvent.setup();
    render(<StayGuests stay={STAY} readOnly={false} />);
    await user.click(screen.getByRole('button', { name: 'Postavi kao nosioca: Bojan Bošković' }));
    await waitFor(() =>
      expect(within(screen.getByRole('listitem', { name: 'Bojan Bošković' })).getByText('Nosilac')).toBeInTheDocument(),
    );
    expect(within(screen.getByRole('listitem', { name: 'Ana Anić' })).queryByText('Nosilac')).toBeNull();
    expect(calls).toEqual([{ method: 'POST', url: '/api/stays/s1/guests/g2/primary', body: undefined }]);
  });

  it('shows the server refusal in words and keeps the list', async () => {
    mockFetch({ 'POST /api/stays/s1/guests': apiError(422, 'too_many_guests', 'x', { limit: 3 }) });
    const user = userEvent.setup();
    render(<StayGuests stay={STAY} readOnly={false} />);
    await user.click(screen.getByRole('button', { name: 'Dodaj gosta' }));
    await user.type(screen.getByLabelText('Ime'), 'Čedomir');
    await user.type(screen.getByLabelText('Prezime'), 'Čolić');
    await user.click(screen.getByRole('button', { name: 'Dodaj novog gosta' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Na boravku može biti najviše 3 gostiju (odrasli i deca zajedno).',
    );
    expect(screen.getAllByRole('listitem', { name: /Anić|Bošković/ })).toHaveLength(2);
  });

  it('a double click on Ukloni sends one request', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = mockFetch({
      'DELETE /api/stays/s1/guests/g2': async () => {
        await gate;
        return { body: [ANA] };
      },
    });
    const user = userEvent.setup();
    render(<StayGuests stay={STAY} readOnly={false} />);
    await user.dblClick(screen.getByRole('button', { name: 'Ukloni gosta Bojan Bošković' }));
    release();
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Bojan Bošković' })).toBeNull());
    expect(calls).toHaveLength(1);
  });

it('two clicks on Ukloni in the same tick (before the button is disabled) still send one request', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = mockFetch({
      'DELETE /api/stays/s1/guests/g2': async () => {
        await gate;
        return { body: [ANA] };
      },
    });
    render(<StayGuests stay={STAY} readOnly={false} />);
    const remove = screen.getByRole('button', { name: 'Ukloni gosta Bojan Bošković' });
    act(() => {
      remove.click();
      remove.click();
    });
    release();
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Bojan Bošković' })).toBeNull());
    expect(calls).toHaveLength(1);
  });

  it('takes the guests of a re-read reservation over its own list', () => {
    const { rerender } = render(<StayGuests stay={STAY} readOnly={false} />);
    expect(screen.getByRole('listitem', { name: 'Bojan Bošković' })).toBeInTheDocument();
    rerender(<StayGuests stay={stayWith({ guests: [ANA, CEDA] })} readOnly={false} />);
    expect(screen.queryByRole('listitem', { name: 'Bojan Bošković' })).toBeNull();
    expect(screen.getByRole('listitem', { name: 'Čedomir Čolić' })).toBeInTheDocument();
  });
});
