import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockFetch } from '@/test/fetch-mock';
import type { ReservationMessage } from '@/lib/types';
import { ReservationMessages } from './reservation-messages';

const message = (over: Partial<ReservationMessage>): ReservationMessage => ({
  id: 'm1',
  template: 'reservation_confirmed',
  recipient: 'ana@example.com',
  status: 'pending',
  attempts: 0,
  lastError: null,
  nextAttemptAt: '2026-11-12T08:00:00.000Z',
  sentAt: null,
  history: [],
  ...over,
});

const LIST = 'GET /api/reservations/r1/messages';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReservationMessages', () => {
  it('shows each state of a mail in words, and Pošalji ponovo only for the one that was not sent', async () => {
    mockFetch({
      [LIST]: {
        body: [
          message({ id: 'm1', status: 'sent', sentAt: '2026-11-12T08:01:00.000Z' }),
          message({ id: 'm2', template: 'reservation_cancelled', status: 'pending' }),
          message({ id: 'm3', status: 'failed', attempts: 6, lastError: 'Server ne odgovara.' }),
          message({ id: 'm4', status: 'skipped', recipient: null, lastError: 'Gost nema e-adresu.' }),
        ],
      },
    });
    render(<ReservationMessages reservationId="r1" />);
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(within(items[0]).getByText('Poslato')).toBeInTheDocument();
    expect(within(items[1]).getByText('Čeka slanje')).toBeInTheDocument();
    expect(items[1]).toHaveTextContent('Otkazivanje rezervacije');
    expect(within(items[2]).getByText('Nije poslato: Server ne odgovara.')).toBeInTheDocument();
    expect(within(items[3]).getByText('Gost nema e-adresu')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Pošalji ponovo' })).toHaveLength(1);
    expect(within(items[2]).getByRole('button', { name: 'Pošalji ponovo' })).toBeEnabled();
  });

  it('resends the mail that was not sent and reads the list again', async () => {
    let sent = false;
    const calls = mockFetch({
      [LIST]: () => ({ body: [message({ status: sent ? 'pending' : 'failed', lastError: 'Server ne odgovara.' })] }),
      'POST /api/messages/m1/resend': () => {
        sent = true;
        return { body: { id: 'm1', status: 'pending' } };
      },
    });
    const user = userEvent.setup();
    render(<ReservationMessages reservationId="r1" />);
    await user.click(await screen.findByRole('button', { name: 'Pošalji ponovo' }));
    expect(await screen.findByText('Čeka slanje')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pošalji ponovo' })).toBeNull();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', url: '/api/messages/m1/resend', body: undefined }]);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('a double click on Pošalji ponovo sends one request', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = mockFetch({
      [LIST]: { body: [message({ status: 'failed', lastError: 'x' })] },
      'POST /api/messages/m1/resend': async () => {
        await gate;
        return { body: { id: 'm1', status: 'pending' } };
      },
    });
    const user = userEvent.setup();
    render(<ReservationMessages reservationId="r1" />);
    await user.dblClick(await screen.findByRole('button', { name: 'Pošalji ponovo' }));
    release();
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('a mail that went out in the meantime shows message_already_sent and the list is read again', async () => {
    let state: 'failed' | 'sent' = 'failed';
    mockFetch({
      [LIST]: () => ({ body: [message({ status: state, lastError: 'x' })] }),
      'POST /api/messages/m1/resend': () => {
        state = 'sent';
        return apiError(409, 'message_already_sent');
      },
    });
    const user = userEvent.setup();
    render(<ReservationMessages reservationId="r1" />);
    await user.click(await screen.findByRole('button', { name: 'Pošalji ponovo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Poruka je već poslata.');
    expect(await screen.findByText('Poslato')).toBeInTheDocument();
  });

  it('in safe mode Pošalji ponovo is disabled', async () => {
    mockFetch({ [LIST]: { body: [message({ status: 'failed', lastError: 'x' })] } });
    render(<ReservationMessages reservationId="r1" readOnly />);
    expect(await screen.findByRole('button', { name: 'Pošalji ponovo' })).toBeDisabled();
  });

  it('says so when there are no mails, and when they cannot be loaded', async () => {
    mockFetch({ [LIST]: { body: [] } });
    const first = render(<ReservationMessages reservationId="r1" />);
    expect(await screen.findByText('Gostu još nije poslata nijedna poruka.')).toBeInTheDocument();
    first.unmount();

    mockFetch({ [LIST]: apiError(500, 'unknown') });
    render(<ReservationMessages reservationId="r1" />);
    expect(await screen.findByText('Poruke trenutno ne mogu da se učitaju.')).toBeInTheDocument();
  });
});
