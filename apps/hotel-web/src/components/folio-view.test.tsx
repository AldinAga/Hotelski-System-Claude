import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '@/lib/api';
import type { Folio, FolioLine, FolioPayment } from '@/lib/types';
import { apiError, mockFetch, type Call } from '@/test/fetch-mock';
import { FolioView } from './folio-view';

const STAY = '66666666-6666-4666-8666-666666666666';
const RES = '55555555-5555-4555-8555-555555555555';
const UNIT = '22222222-2222-4222-8222-222222222222';
const KEY = /^[A-Za-z0-9_-]{8,100}$/;

const RESERVATION = {
  id: RES,
  number: 'R-2026-000007',
  status: 'confirmed',
  version: 3,
  holder: { id: 'h', firstName: 'Marija', lastName: 'Marković', email: null, phone: null, language: 'sr' },
  stays: [
    {
      id: STAY,
      unitTypeId: null,
      unitId: UNIT,
      arrival: '2026-11-02',
      departure: '2026-11-05',
      adults: 2,
      children: 0,
      ratePlanId: 'p',
      status: 'in_house',
      nights: [],
      totalMinor: 3_000_000,
      guests: [{ id: 'g1', firstName: 'Petar', lastName: 'Petrović', email: null, phone: null, language: 'sr', note: null, isPrimary: true }],
    },
  ],
  totalMinor: 3_000_000,
};

function line(over: Partial<FolioLine> = {}): FolioLine {
  return {
    id: 'line-a',
    kind: 'accommodation',
    description: 'Smeštaj 2.11.2026',
    amountMinor: 1_000_000,
    vatRateBp: 1000,
    businessDate: '2026-11-02',
    night: '2026-11-02',
    sourceType: 'night_audit',
    reversesLineId: null,
    reversedBy: null,
    reason: null,
    createdAt: '2026-11-02T22:00:00.000Z',
    ...over,
  };
}

function payment(over: Partial<FolioPayment> = {}): FolioPayment {
  return {
    id: 'pay-a',
    method: 'cash',
    amountMinor: 500_000,
    businessDate: '2026-11-03',
    reference: null,
    reversesPaymentId: null,
    voidedBy: null,
    reason: null,
    createdAt: '2026-11-03T09:00:00.000Z',
    ...over,
  };
}

// The totals are deliberately not the sum of the rows: the screen shows what the server says.
const FOLIO: Folio = {
  id: 'folio-1',
  stayId: STAY,
  reservationId: RES,
  status: 'open',
  lines: [line(), line({ id: 'line-b', description: 'Smeštaj 3.11.2026', businessDate: '2026-11-03', night: '2026-11-03' })],
  payments: [],
  chargesMinor: 2_345_600,
  paymentsMinor: 0,
  balanceMinor: 2_000_000,
  unpostedNights: [],
  vatRatesBp: [1000, 2000],
  fiscalNotice: null,
};

const PAYMENT_VIEW = payment({ id: 'pay-new' });
const CHARGE_VIEW = line({ id: 'line-new', kind: 'service', description: 'Minibar' });
const DOC_VIEW = { id: 'doc-1', kind: 'receipt', number: 'N-2026-000001', issuedAt: '2026-11-03T10:00:00.000Z', content: {} };

interface Opts {
  role?: string;
  licence?: string;
  folio?: Partial<Folio>;
  stayStatus?: string;
  documents?: unknown[];
  extra?: Record<string, unknown>;
}

function routes(o: Opts = {}) {
  const reservation = {
    ...RESERVATION,
    stays: [{ ...RESERVATION.stays[0], status: o.stayStatus ?? 'in_house' }],
  };
  return {
    'GET /api/licence': { body: { activated: true, modules: ['hotel.folio'], limits: {}, state: o.licence ?? 'VALID' } },
    'GET /api/auth/me': { body: { role: o.role ?? 'owner' } },
    [`GET /api/stays/${STAY}/folio`]: { body: { ...FOLIO, ...o.folio } },
    [`GET /api/stays/${STAY}/folio/documents`]: { body: o.documents ?? [] },
    [`GET /api/reservations/${RES}`]: { body: reservation },
    'GET /api/units': { body: [{ id: UNIT, name: 'Soba 101', unitTypeId: null, active: true }] },
    ...o.extra,
  } as Parameters<typeof mockFetch>[0];
}

const postsTo = (calls: Call[], path: string) => calls.filter((c) => c.method === 'POST' && c.url === `/api${path}`);
const folioReads = (calls: Call[]) => calls.filter((c) => c.method === 'GET' && c.url === `/api/stays/${STAY}/folio`).length;

/** Lets the licence and the role answers arrive, so "no such button" is not just "not loaded yet". */
async function settled() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function open(o: Opts = {}) {
  const calls = mockFetch(routes(o));
  const user = userEvent.setup();
  render(<FolioView stayId={STAY} />);
  await screen.findByText('Ukupno');
  await settled();
  return { calls, user };
}

const dialog = (name: string) => screen.getByRole('dialog', { name });

beforeEach(() => {
  vi.spyOn(navigation, 'go').mockImplementation(() => undefined);
  window.history.replaceState(null, '', `/folio/${STAY}`);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FolioView: what is shown', () => {
  it('shows the guest, reservation, unit and dates, and the totals exactly as the server computed them', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1, name: 'Folio' })).toBeInTheDocument();
    expect(screen.getByText('Petar Petrović')).toBeInTheDocument();
    expect(screen.getByText('Rezervacija R-2026-000007 · Jedinica Soba 101 · 2.11.2026 – 5.11.2026')).toBeInTheDocument();
    expect(screen.getByText('Otvoren')).toBeInTheDocument();
    // Ukupno 23.456,00 although the two lines sum to 20.000,00: no money math in the browser.
    expect(screen.getByText('Ukupno').nextElementSibling).toHaveTextContent('23.456,00 RSD');
    expect(screen.getByText('Plaćeno').nextElementSibling).toHaveTextContent('0,00 RSD');
    expect(screen.getByText('Saldo').nextElementSibling).toHaveTextContent('20.000,00 RSD');
    expect(screen.getByRole('link', { name: '‹ Rezervacija R-2026-000007' })).toHaveAttribute('href', `/rezervacije/${RES}`);
  });

  it('lists the lines by date, description and amount', async () => {
    await open();
    const table = screen.getByRole('table', { name: 'Stavke folija' });
    const rows = within(table).getAllByRole('row');
    // header + 2 lines
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText('2.11.2026', { selector: 'td' })).toBeInTheDocument();
    expect(within(rows[1]).getByText('Smeštaj 2.11.2026')).toBeInTheDocument();
    expect(within(rows[1]).getByText('10.000,00 RSD')).toBeInTheDocument();
  });

  it('a negative balance says the guest has a credit', async () => {
    await open({ folio: { chargesMinor: 1_000_000, paymentsMinor: 1_500_000, balanceMinor: -500_000 } });
    expect(screen.getByText('Saldo').nextElementSibling).toHaveTextContent('-5.000,00 RSD');
    expect(screen.getByText('Gost ima kredit 5.000,00 RSD')).toBeInTheDocument();
  });

  it('no credit text while the balance is zero or positive', async () => {
    await open();
    expect(screen.queryByText(/Gost ima kredit/)).toBeNull();
  });

  it('shows the nights still expected, each with its price', async () => {
    await open({ folio: { unpostedNights: [{ night: '2026-11-04', priceMinor: 1_000_000 }] } });
    const section = screen.getByRole('region', { name: 'Očekivane noći' });
    expect(within(section).getByText('4.11.2026')).toBeInTheDocument();
    expect(within(section).getByText('10.000,00 RSD')).toBeInTheDocument();
  });

  it('has no expected-nights section when every night is posted', async () => {
    await open();
    expect(screen.queryByRole('region', { name: 'Očekivane noći' })).toBeNull();
  });

  it('shows the fiscal notice when the server sends it (F8)', async () => {
    await open({ folio: { fiscalNotice: 'not_available_yet' } });
    expect(screen.getByText('Fiskalizacija još nije uključena; plaćanja se beleže bez fiskalnog računa.')).toBeInTheDocument();
  });

  it('shows no fiscal notice when the server sends none', async () => {
    await open();
    expect(screen.queryByText(/Fiskalizacija još nije uključena/)).toBeNull();
  });

  it('shows a reversed line struck through, linked to its reversal, and the reversal linked back (F26)', async () => {
    await open({
      folio: {
        lines: [
          line({ id: 'line-a', reversedBy: 'line-r' }),
          line({ id: 'line-r', kind: 'correction', description: 'Storno: Smeštaj 2.11.2026', amountMinor: -1_000_000, reversesLineId: 'line-a', reason: 'Pogrešna noć', sourceType: 'reversal' }),
        ],
      },
    });
    const original = document.getElementById('line-line-a') as HTMLElement;
    const reversal = document.getElementById('line-line-r') as HTMLElement;
    expect(original).toHaveClass('is-reversed');
    expect(reversal).not.toHaveClass('is-reversed');
    expect(within(original).getByRole('link', { name: 'Stornirano (vidi storno)' })).toHaveAttribute('href', '#line-line-r');
    expect(within(reversal).getByRole('link', { name: 'Storno stavke (vidi original)' })).toHaveAttribute('href', '#line-line-a');
    expect(within(reversal).getByText('Razlog: Pogrešna noć')).toBeInTheDocument();
  });

  it('shows payments by method, with refunds, voids and references named', async () => {
    await open({
      folio: {
        payments: [
          payment({ id: 'p1', method: 'card', amountMinor: 700_000, reference: 'POS-4411', voidedBy: 'p2' }),
          payment({ id: 'p2', method: 'card', amountMinor: -700_000, reversesPaymentId: 'p1', reason: 'Dvaput naplaćeno' }),
          payment({ id: 'p3', method: 'cash', amountMinor: -50_000, reason: 'Vraćen višak' }),
        ],
      },
    });
    const table = screen.getByRole('table', { name: 'Plaćanja na foliju' });
    const original = document.getElementById('payment-p1') as HTMLElement;
    expect(original).toHaveClass('is-reversed');
    expect(within(original).getByText('Kartica')).toBeInTheDocument();
    expect(within(original).getByText('Referenca: POS-4411')).toBeInTheDocument();
    expect(within(original).getByRole('link', { name: 'Stornirano (vidi storno)' })).toHaveAttribute('href', '#payment-p2');
    expect(within(table).getByText('Storno plaćanja: Kartica')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'Storno plaćanja (vidi original)' })).toHaveAttribute('href', '#payment-p1');
    expect(within(table).getByText('Povraćaj: Gotovina')).toBeInTheDocument();
    expect(within(table).getByText('-500,00 RSD')).toBeInTheDocument();
  });

  it('a stay without a folio yet shows empty tables and still offers charges and payments (F37)', async () => {
    await open({ folio: { id: null, status: 'none', lines: [], payments: [], chargesMinor: 0, paymentsMinor: 0, balanceMinor: 0 } });
    expect(screen.getByText('Bez stavki')).toBeInTheDocument();
    expect(screen.getByText('Na foliju još nema stavki.')).toBeInTheDocument();
    expect(screen.getByText('Još nema plaćanja.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dodaj zaduženje' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Naplati' })).toBeEnabled();
  });

  it('lists the documents already issued, linked to their page', async () => {
    await open({ documents: [{ id: 'doc-9', kind: 'proforma', number: 'P-2026-000003', issuedAt: '2026-11-03T13:05:00.000Z' }] });
    const link = screen.getByRole('link', { name: 'Predračun P-2026-000003' });
    expect(link).toHaveAttribute('href', '/dokumenti/doc-9');
    expect(screen.getByText('3.11.2026 14:05')).toBeInTheDocument();
  });

  it('shows the dictionary message when the stay does not exist', async () => {
    mockFetch({
      'GET /api/licence': { body: { activated: true, modules: [], limits: {}, state: 'VALID' } },
      'GET /api/auth/me': { body: { role: 'owner' } },
      [`GET /api/stays/${STAY}/folio`]: apiError(404, 'stay_not_found'),
      [`GET /api/stays/${STAY}/folio/documents`]: apiError(404, 'stay_not_found'),
    });
    render(<FolioView stayId={STAY} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Boravak ne postoji. Osvežite stranicu.');
    expect(screen.queryByText('Ukupno')).toBeNull();
  });

  it('the page heading can take focus (the back-to-top button moves it there)', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1, name: 'Folio' })).toHaveAttribute('tabindex', '-1');
  });
});

describe('FolioView: Naplati', () => {
  it('the balance 20.000,00 is the default amount, and submitting sends it in minor units', async () => {
    const { calls, user } = await open({ extra: { [`POST /api/stays/${STAY}/folio/payments`]: { status: 201, body: PAYMENT_VIEW } } });
    await user.click(screen.getByRole('button', { name: 'Naplati' }));
    const d = dialog('Naplata');
    expect(within(d).getByLabelText('Iznos (RSD)')).toHaveValue('20.000,00');
    expect(within(d).getByLabelText('Način plaćanja')).toHaveValue('cash');
    await user.click(within(d).getByRole('button', { name: 'Naplati' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const posts = postsTo(calls, `/stays/${STAY}/folio/payments`);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ method: 'cash', amountMinor: 2_000_000, key: expect.stringMatching(KEY) });
    expect(screen.getByRole('status')).toHaveTextContent('Naplata je zabeležena.');
  });

  it('the dialog says what the balance is, and the default is empty when there is nothing to pay', async () => {
    const { user } = await open({ folio: { balanceMinor: 0, chargesMinor: 0 } });
    await user.click(screen.getByRole('button', { name: 'Naplati' }));
    expect(within(dialog('Naplata')).getByLabelText('Iznos (RSD)')).toHaveValue('');
    expect(within(dialog('Naplata')).queryByText(/Saldo folija je/)).toBeNull();
  });

  it('sends the chosen method, the typed amount and the trimmed reference', async () => {
    const { calls, user } = await open({ extra: { [`POST /api/stays/${STAY}/folio/payments`]: { status: 201, body: PAYMENT_VIEW } } });
    await user.click(screen.getByRole('button', { name: 'Naplati' }));
    const d = dialog('Naplata');
    await user.selectOptions(within(d).getByLabelText('Način plaćanja'), 'card');
    await user.clear(within(d).getByLabelText('Iznos (RSD)'));
    await user.type(within(d).getByLabelText('Iznos (RSD)'), '1.234,56');
    await user.type(within(d).getByLabelText('Referenca (nije obavezna)'), '  POS-77  ');
    await user.click(within(d).getByRole('button', { name: 'Naplati' }));
    await waitFor(() => expect(postsTo(calls, `/stays/${STAY}/folio/payments`)).toHaveLength(1));
    expect(postsTo(calls, `/stays/${STAY}/folio/payments`)[0].body).toMatchObject({
      method: 'card',
      amountMinor: 123456,
      reference: 'POS-77',
    });
  });

  it('a repeated 200 is shown like the first 201', async () => {
    const { calls, user } = await open({ extra: { [`POST /api/stays/${STAY}/folio/payments`]: { status: 200, body: PAYMENT_VIEW } } });
    await user.click(screen.getByRole('button', { name: 'Naplati' }));
    await user.click(within(dialog('Naplata')).getByRole('button', { name: 'Naplati' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('status')).toHaveTextContent('Naplata je zabeležena.');
    expect(folioReads(calls)).toBe(2);
  });

  it('an amount that is not an amount, or is zero, is refused without a request', async () => {
    const { calls, user } = await open();
    await user.click(screen.getByRole('button', { name: 'Naplati' }));
    const d = dialog('Naplata');
    const amount = within(d).getByLabelText('Iznos (RSD)');
    for (const [text, message] of [
      ['abc', 'Unesite iznos u dinarima, na primer 1.500,00.'],
      ['0,005', 'Unesite iznos u dinarima, na primer 1.500,00.'],
      ['-5', 'Unesite iznos u dinarima, na primer 1.500,00.'],
      ['0', 'Iznos mora biti veći od nule.'],
      ['100.000.001,00', 'Iznos je prevelik.'],
    ] as const) {
      await user.clear(amount);
      await user.type(amount, text);
      await user.click(within(d).getByRole('button', { name: 'Naplati' }));
      expect(within(d).getByRole('alert')).toHaveTextContent(message);
    }
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('Odustani closes the dialog and sends nothing', async () => {
    const { calls, user } = await open();
    await user.click(screen.getByRole('button', { name: 'Naplati' }));
    await user.click(within(dialog('Naplata')).getByRole('button', { name: 'Odustani' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('moves focus into the dialog and gives it back to Naplati when it closes', async () => {
    const { user } = await open();
    const opener = screen.getByRole('button', { name: 'Naplati' });
    await user.click(opener);
    expect(screen.getByRole('heading', { name: 'Naplata' })).toHaveFocus();
    await user.click(within(dialog('Naplata')).getByRole('button', { name: 'Odustani' }));
    expect(opener).toHaveFocus();
  });

  it('a double click in one tick sends one payment, and the button is disabled while it runs', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = mockFetch(
      routes({
        extra: {
          [`POST /api/stays/${STAY}/folio/payments`]: async () => {
            await gate;
            return { status: 201, body: PAYMENT_VIEW };
          },
        },
      }),
    );
    const user = userEvent.setup();
    render(<FolioView stayId={STAY} />);
    await screen.findByText('Ukupno');
    await user.click(screen.getByRole('button', { name: 'Naplati' }));
    const submit = within(dialog('Naplata')).getByRole('button', { name: 'Naplati' });
    // Two clicks before React can re-render: only the in-flight guard stops the second.
    act(() => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });
    expect(submit).toBeDisabled();
    expect(within(dialog('Naplata')).getByRole('button', { name: 'Odustani' })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(postsTo(calls, `/stays/${STAY}/folio/payments`)).toHaveLength(1);
  });

  it('a retry after a network error sends the same key; a new dialog sends a new one', async () => {
    let attempts = 0;
    const calls = mockFetch(
      routes({
        extra: {
          [`POST /api/stays/${STAY}/folio/payments`]: () => {
            attempts += 1;
            if (attempts === 1) throw new TypeError('Failed to fetch');
            return { status: 201, body: PAYMENT_VIEW };
          },
        },
      }),
    );
    const user = userEvent.setup();
    render(<FolioView stayId={STAY} />);
    await screen.findByText('Ukupno');
    await user.click(screen.getByRole('button', { name: 'Naplati' }));
    await user.click(within(dialog('Naplata')).getByRole('button', { name: 'Naplati' }));
    expect(await within(dialog('Naplata')).findByRole('alert')).toHaveTextContent('Server nije dostupan. Proverite vezu i pokušajte ponovo.');
    await user.click(within(dialog('Naplata')).getByRole('button', { name: 'Naplati' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [first, second] = postsTo(calls, `/stays/${STAY}/folio/payments`);
    expect((first.body as { key: string }).key).toMatch(KEY);
    expect((second.body as { key: string }).key).toBe((first.body as { key: string }).key);

    // The next payment is a different intent.
    await user.click(screen.getByRole('button', { name: 'Naplati' }));
    await user.click(within(dialog('Naplata')).getByRole('button', { name: 'Naplati' }));
    await waitFor(() => expect(postsTo(calls, `/stays/${STAY}/folio/payments`)).toHaveLength(3));
    const third = postsTo(calls, `/stays/${STAY}/folio/payments`)[2];
    expect((third.body as { key: string }).key).not.toBe((first.body as { key: string }).key);
  });

  it('idempotency_key_reused shows the message, keeps the dialog open and reads the folio again', async () => {
    const { calls, user } = await open({
      extra: { [`POST /api/stays/${STAY}/folio/payments`]: apiError(409, 'idempotency_key_reused') },
    });
    await user.click(screen.getByRole('button', { name: 'Naplati' }));
    await user.click(within(dialog('Naplata')).getByRole('button', { name: 'Naplati' }));
    expect(await within(dialog('Naplata')).findByRole('alert')).toHaveTextContent(
      'Ovaj zahtev je već zabeležen, ali sa drugačijim podacima. Zatvorite prozor i proverite folio pre nego što pokušate ponovo.',
    );
    expect(screen.getByRole('dialog', { name: 'Naplata' })).toBeInTheDocument();
    await waitFor(() => expect(folioReads(calls)).toBe(2));
  });

  it('a conflict (folio_closed) closes the dialog, says why on the page and reads the folio again', async () => {
    const { calls, user } = await open({ extra: { [`POST /api/stays/${STAY}/folio/payments`]: apiError(409, 'folio_closed') } });
    await user.click(screen.getByRole('button', { name: 'Naplati' }));
    await user.click(within(dialog('Naplata')).getByRole('button', { name: 'Naplati' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('alert')).toHaveTextContent('Folio je zatvoren i ne prima nove stavke ni plaćanja.');
    await waitFor(() => expect(folioReads(calls)).toBe(2));
  });
});

describe('FolioView: Dodaj zaduženje', () => {
  async function fill(user: ReturnType<typeof userEvent.setup>, d: HTMLElement, text: { description: string; amount: string }) {
    await user.type(within(d).getByLabelText('Opis'), text.description);
    await user.type(within(d).getByLabelText('Iznos (RSD)'), text.amount);
  }

  it('sends kind, description, amount in minor units and the chosen VAT rate from the folio', async () => {
    const { calls, user } = await open({ extra: { [`POST /api/stays/${STAY}/folio/charges`]: { status: 201, body: CHARGE_VIEW } } });
    await user.click(screen.getByRole('button', { name: 'Dodaj zaduženje' }));
    const d = dialog('Dodaj zaduženje');
    expect(within(d).getByLabelText('Vrsta')).toHaveValue('service');
    // The rates are the folio's own, formatted as percentages.
    expect(within(d).getAllByRole('option').map((o) => o.textContent)).toEqual(['Usluga', 'Naknada', 'Izaberite stopu', '10 %', '20 %']);
    await user.selectOptions(within(d).getByLabelText('Vrsta'), 'fee');
    await fill(user, d, { description: '  Parking  ', amount: '1.500,50' });
    await user.selectOptions(within(d).getByLabelText('PDV stopa'), '2000');
    await user.click(within(d).getByRole('button', { name: 'Dodaj' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(postsTo(calls, `/stays/${STAY}/folio/charges`)[0].body).toEqual({
      kind: 'fee',
      description: 'Parking',
      amountMinor: 150050,
      vatRateBp: 2000,
      key: expect.stringMatching(KEY),
    });
    expect(screen.getByRole('status')).toHaveTextContent('Zaduženje je dodato.');
  });

  it('does not send a charge without a VAT rate when the folio has rates (F38)', async () => {
    const { calls, user } = await open();
    await user.click(screen.getByRole('button', { name: 'Dodaj zaduženje' }));
    const d = dialog('Dodaj zaduženje');
    await fill(user, d, { description: 'Minibar', amount: '300' });
    await user.click(within(d).getByRole('button', { name: 'Dodaj' }));
    expect(within(d).getByRole('alert')).toHaveTextContent('Izaberite PDV stopu.');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('without rates in the settings there is no VAT field and the charge goes out with no rate', async () => {
    const { calls, user } = await open({
      folio: { vatRatesBp: [] },
      extra: { [`POST /api/stays/${STAY}/folio/charges`]: { status: 201, body: CHARGE_VIEW } },
    });
    await user.click(screen.getByRole('button', { name: 'Dodaj zaduženje' }));
    const d = dialog('Dodaj zaduženje');
    expect(within(d).queryByLabelText('PDV stopa')).toBeNull();
    await fill(user, d, { description: 'Minibar', amount: '300' });
    await user.click(within(d).getByRole('button', { name: 'Dodaj' }));
    await waitFor(() => expect(postsTo(calls, `/stays/${STAY}/folio/charges`)).toHaveLength(1));
    expect(postsTo(calls, `/stays/${STAY}/folio/charges`)[0].body).toMatchObject({ amountMinor: 30000, vatRateBp: null });
  });

  it('a description is required, and an amount must be an amount', async () => {
    const { calls, user } = await open({ folio: { vatRatesBp: [] } });
    await user.click(screen.getByRole('button', { name: 'Dodaj zaduženje' }));
    const d = dialog('Dodaj zaduženje');
    await user.type(within(d).getByLabelText('Iznos (RSD)'), '300');
    await user.click(within(d).getByRole('button', { name: 'Dodaj' }));
    expect(within(d).getByRole('alert')).toHaveTextContent('Unesite opis zaduženja.');
    await user.type(within(d).getByLabelText('Opis'), 'Minibar');
    await user.clear(within(d).getByLabelText('Iznos (RSD)'));
    await user.type(within(d).getByLabelText('Iznos (RSD)'), '1,234');
    await user.click(within(d).getByRole('button', { name: 'Dodaj' }));
    expect(within(d).getByRole('alert')).toHaveTextContent('Unesite iznos u dinarima, na primer 1.500,00.');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('a stay that cannot be charged any more refuses with the dictionary message and closes the dialog', async () => {
    const { user } = await open({
      folio: { vatRatesBp: [] },
      extra: { [`POST /api/stays/${STAY}/folio/charges`]: apiError(409, 'stay_not_chargeable', 'x', { status: 'cancelled' }) },
    });
    await user.click(screen.getByRole('button', { name: 'Dodaj zaduženje' }));
    await fill(user, dialog('Dodaj zaduženje'), { description: 'Minibar', amount: '300' });
    await user.click(within(dialog('Dodaj zaduženje')).getByRole('button', { name: 'Dodaj' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('alert')).toHaveTextContent('Na boravak u ovom stanju ne mogu se dodavati zaduženja.');
  });

  it('is not offered for a stay that can no longer be charged, but payments are', async () => {
    await open({ stayStatus: 'cancelled', folio: { id: null, status: 'none', lines: [], payments: [], chargesMinor: 0, balanceMinor: 0 } });
    expect(screen.queryByRole('button', { name: 'Dodaj zaduženje' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Naplati' })).toBeEnabled();
  });
});

describe('FolioView: roles', () => {
  // Every fixture here has a credit, an un-reversed line and a payment, so the buttons would show if the role allowed them.
  const WITH_EVERYTHING: Partial<Folio> = {
    lines: [line()],
    payments: [payment()],
    chargesMinor: 1_000_000,
    paymentsMinor: 1_500_000,
    balanceMinor: -500_000,
  };

  it('a manager sees Vrati novac and Storniraj on lines and payments', async () => {
    await open({ role: 'manager', folio: WITH_EVERYTHING });
    expect(screen.getByRole('button', { name: 'Vrati novac' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Storniraj: Smeštaj 2.11.2026' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Storniraj plaćanje: Gotovina/ })).toBeEnabled();
  });

  it('the dugmad Vrati novac and Storniraj do not exist for a receptionist, who can still charge and take payments', async () => {
    await open({ role: 'receptionist', folio: WITH_EVERYTHING });
    expect(screen.getByRole('button', { name: 'Naplati' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Dodaj zaduženje' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Vrati novac' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Storniraj/ })).toBeNull();
  });

  it('Vrati novac exists only when there is a credit', async () => {
    await open({ role: 'owner', folio: { ...WITH_EVERYTHING, balanceMinor: 0 } });
    expect(screen.getByRole('button', { name: /^Storniraj:/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Vrati novac' })).toBeNull();
  });
});

describe('FolioView: Vrati novac', () => {
  const CREDIT: Partial<Folio> = { chargesMinor: 1_000_000, paymentsMinor: 1_500_000, balanceMinor: -500_000 };

  it('offers the credit as the amount, wants a reason and sends the refund', async () => {
    const { calls, user } = await open({
      folio: CREDIT,
      extra: { [`POST /api/stays/${STAY}/folio/refunds`]: { status: 201, body: payment({ id: 'r1', amountMinor: -500_000 }) } },
    });
    await user.click(screen.getByRole('button', { name: 'Vrati novac' }));
    const d = dialog('Vrati novac');
    expect(within(d).getByLabelText('Iznos (RSD)')).toHaveValue('5.000,00');
    await user.click(within(d).getByRole('button', { name: 'Vrati novac' }));
    expect(within(d).getByRole('alert')).toHaveTextContent('Unesite razlog povraćaja.');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    await user.type(within(d).getByLabelText('Razlog'), '  Gost je otišao ranije  ');
    await user.click(within(d).getByRole('button', { name: 'Vrati novac' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(postsTo(calls, `/stays/${STAY}/folio/refunds`)[0].body).toEqual({
      method: 'cash',
      amountMinor: 500_000,
      reason: 'Gost je otišao ranije',
      key: expect.stringMatching(KEY),
    });
    expect(screen.getByRole('status')).toHaveTextContent('Povraćaj je zabeležen.');
  });

  it('a refund above the credit shows the limit in dinars, keeps the dialog and reads the folio again', async () => {
    const { calls, user } = await open({
      folio: CREDIT,
      extra: { [`POST /api/stays/${STAY}/folio/refunds`]: apiError(422, 'refund_exceeds_credit', 'x', { creditMinor: 400_000 }) },
    });
    await user.click(screen.getByRole('button', { name: 'Vrati novac' }));
    await user.type(within(dialog('Vrati novac')).getByLabelText('Razlog'), 'Višak');
    await user.click(within(dialog('Vrati novac')).getByRole('button', { name: 'Vrati novac' }));
    expect(await within(dialog('Vrati novac')).findByRole('alert')).toHaveTextContent(
      'Povraćaj ne može biti veći od preplate na foliju (4.000,00 RSD).',
    );
    await waitFor(() => expect(folioReads(calls)).toBe(2));
  });
});

describe('FolioView: Storniraj', () => {
  it('reverses a line with a reason, sends the key, and is not sent without a reason', async () => {
    const { calls, user } = await open({
      extra: { 'POST /api/folio-lines/line-b/reverse': { status: 201, body: line({ id: 'line-r', kind: 'correction' }) } },
    });
    await user.click(screen.getByRole('button', { name: 'Storniraj: Smeštaj 3.11.2026' }));
    const d = dialog('Storniraj stavku');
    expect(within(d).getByText(/Smeštaj 3\.11\.2026/)).toBeInTheDocument();
    await user.click(within(d).getByRole('button', { name: 'Storniraj' }));
    expect(within(d).getByRole('alert')).toHaveTextContent('Unesite razlog storna.');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    await user.type(within(d).getByLabelText('Razlog'), 'Gost nije spavao');
    await user.click(within(d).getByRole('button', { name: 'Storniraj' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(postsTo(calls, '/folio-lines/line-b/reverse')[0].body).toEqual({ reason: 'Gost nije spavao', key: expect.stringMatching(KEY) });
    expect(screen.getByRole('status')).toHaveTextContent('Stavka je stornirana.');
    // Focus does not fall to the page: the row's button may be gone, so it lands on the heading or the button.
    expect(document.activeElement).not.toBe(document.body);
  });

  it('is not offered on a correction or on a line that is already reversed', async () => {
    await open({
      folio: {
        lines: [
          line({ id: 'line-a', reversedBy: 'line-r' }),
          line({ id: 'line-r', kind: 'correction', description: 'Storno: Smeštaj 2.11.2026', amountMinor: -1_000_000, reversesLineId: 'line-a' }),
          line({ id: 'line-c', description: 'Doručak' }),
        ],
      },
    });
    expect(screen.getAllByRole('button', { name: /^Storniraj:/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Storniraj: Doručak' })).toBeInTheDocument();
  });

  it('voids a payment with a reason', async () => {
    const { calls, user } = await open({
      folio: { payments: [payment({ id: 'pay-x', method: 'card' })], paymentsMinor: 500_000 },
      extra: { 'POST /api/payments/pay-x/void': { status: 201, body: payment({ id: 'pay-v', amountMinor: -500_000 }) } },
    });
    await user.click(screen.getByRole('button', { name: /^Storniraj plaćanje: Kartica/ }));
    const d = dialog('Storniraj plaćanje');
    await user.type(within(d).getByLabelText('Razlog'), 'Pogrešan gost');
    await user.click(within(d).getByRole('button', { name: 'Storniraj' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(postsTo(calls, '/payments/pay-x/void')[0].body).toEqual({ reason: 'Pogrešan gost', key: expect.stringMatching(KEY) });
    expect(screen.getByRole('status')).toHaveTextContent('Plaćanje je stornirano.');
  });

  it('a void is not offered on a reversal, on a payment already voided or on a refund that is itself a reversal', async () => {
    await open({
      folio: {
        payments: [
          payment({ id: 'p1', voidedBy: 'p2' }),
          payment({ id: 'p2', amountMinor: -500_000, reversesPaymentId: 'p1' }),
          payment({ id: 'p3', method: 'transfer' }),
        ],
      },
    });
    expect(screen.getAllByRole('button', { name: /^Storniraj plaćanje:/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^Storniraj plaćanje: Prenos/ })).toBeInTheDocument();
  });

  it('line_already_reversed closes the dialog, says so, and reads the folio again', async () => {
    const { calls, user } = await open({ extra: { 'POST /api/folio-lines/line-a/reverse': apiError(409, 'line_already_reversed') } });
    await user.click(screen.getByRole('button', { name: 'Storniraj: Smeštaj 2.11.2026' }));
    await user.type(within(dialog('Storniraj stavku')).getByLabelText('Razlog'), 'Greška');
    await user.click(within(dialog('Storniraj stavku')).getByRole('button', { name: 'Storniraj' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('alert')).toHaveTextContent('Stavka je već stornirana.');
    await waitFor(() => expect(folioReads(calls)).toBe(2));
  });
});

describe('FolioView: closed folio', () => {
  const CLOSED: Partial<Folio> = {
    status: 'closed',
    lines: [line()],
    payments: [payment()],
    chargesMinor: 1_000_000,
    paymentsMinor: 1_500_000,
    balanceMinor: -500_000,
  };

  it('has no buttons for changes, only documents', async () => {
    await open({ role: 'owner', stayStatus: 'checked_out', folio: CLOSED });
    expect(screen.getByText('Zatvoren')).toBeInTheDocument();
    for (const name of ['Dodaj zaduženje', 'Naplati', 'Vrati novac']) {
      expect(screen.queryByRole('button', { name }), name).toBeNull();
    }
    expect(screen.queryByRole('button', { name: /^Storniraj/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Nefiskalni račun' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Predračun' })).toBeEnabled();
    expect(screen.getByText('Folio je zatvoren: možete ga pregledati i izdati dokumente.')).toBeInTheDocument();
  });

  it('the same folio, open, would have those buttons (the test above is not just a missing role)', async () => {
    await open({ role: 'owner', folio: { ...CLOSED, status: 'open' } });
    expect(screen.getByRole('button', { name: 'Dodaj zaduženje' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Naplati' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Vrati novac' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Storniraj:/ })).toBeInTheDocument();
  });
});

describe('FolioView: licence', () => {
  const BUSY: Partial<Folio> = {
    lines: [line()],
    payments: [payment()],
    chargesMinor: 1_000_000,
    paymentsMinor: 1_500_000,
    balanceMinor: -500_000,
  };

  it('in safe mode Naplati and the documents work, Dodaj zaduženje and every storno do not', async () => {
    await open({ licence: 'EXPIRED', folio: BUSY });
    await screen.findByText(/Licenca je istekla: naplata i dokumenti rade/);
    expect(screen.getByRole('button', { name: 'Naplati' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Vrati novac' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Nefiskalni račun' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Predračun' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Dodaj zaduženje' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Storniraj:/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Storniraj plaćanje:/ })).toBeDisabled();
  });

  it.each(['INVALID', 'NOT_ACTIVATED'])('without a usable licence (%s) nothing can be sent', async (state) => {
    await open({ licence: state, folio: BUSY });
    await screen.findByText(/Licenca nije ispravna/);
    for (const name of ['Naplati', 'Vrati novac', 'Nefiskalni račun', 'Predračun', 'Dodaj zaduženje']) {
      expect(screen.getByRole('button', { name }), name).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: /^Storniraj:/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Storniraj plaćanje:/ })).toBeDisabled();
  });

  it('with a valid licence everything is enabled and no licence hint is shown', async () => {
    await open({ licence: 'VALID', folio: BUSY });
    for (const name of ['Naplati', 'Vrati novac', 'Nefiskalni račun', 'Predračun', 'Dodaj zaduženje']) {
      expect(screen.getByRole('button', { name }), name).toBeEnabled();
    }
    expect(screen.queryByText(/Licenca/)).toBeNull();
  });
});

describe('FolioView: documents', () => {
  const ISSUE = `/stays/${STAY}/folio/documents`;

  it.each([
    ['Nefiskalni račun', 'receipt'],
    ['Predračun', 'proforma'],
  ])('%s issues a %s with a key and opens the document', async (name, kind) => {
    const { calls, user } = await open({ extra: { [`POST /api${ISSUE}`]: { status: 201, body: DOC_VIEW } } });
    await user.click(screen.getByRole('button', { name }));
    await waitFor(() => expect(navigation.go).toHaveBeenCalledWith('/dokumenti/doc-1'));
    expect(postsTo(calls, ISSUE)[0].body).toEqual({ kind, key: expect.stringMatching(KEY) });
  });

  it('a repeated answer (200) opens the document like the first (201)', async () => {
    const { user } = await open({ extra: { [`POST /api${ISSUE}`]: { status: 200, body: DOC_VIEW } } });
    await user.click(screen.getByRole('button', { name: 'Nefiskalni račun' }));
    await waitFor(() => expect(navigation.go).toHaveBeenCalledWith('/dokumenti/doc-1'));
  });

  it('document_empty shows its message, goes nowhere, and a retry sends the same key', async () => {
    const { calls, user } = await open({ extra: { [`POST /api${ISSUE}`]: apiError(409, 'document_empty') } });
    await user.click(screen.getByRole('button', { name: 'Nefiskalni račun' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Folio nema nijednu stavku ni plaćanje, pa dokument ne može da se izda.');
    expect(navigation.go).not.toHaveBeenCalled();
    // A 409 means the folio is not what the screen showed: it is read again.
    await waitFor(() => expect(folioReads(calls)).toBe(2));
    // Buttons are usable again after a refusal.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Nefiskalni račun' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Nefiskalni račun' }));
    await waitFor(() => expect(postsTo(calls, ISSUE)).toHaveLength(2));
    const [a, b] = postsTo(calls, ISSUE);
    expect((b.body as { key: string }).key).toBe((a.body as { key: string }).key);
  });

  it('a double click in one tick issues one document, and both document buttons are disabled meanwhile', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = mockFetch(
      routes({
        extra: {
          [`POST /api${ISSUE}`]: async () => {
            await gate;
            return { status: 201, body: DOC_VIEW };
          },
        },
      }),
    );
    render(<FolioView stayId={STAY} />);
    await screen.findByText('Ukupno');
    const button = screen.getByRole('button', { name: 'Nefiskalni račun' });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(button).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Predračun' })).toBeDisabled();
    release();
    await waitFor(() => expect(navigation.go).toHaveBeenCalledTimes(1));
    expect(postsTo(calls, ISSUE)).toHaveLength(1);
  });

  it('stays busy after a success while the browser leaves the page, so a late click cannot issue a second document', async () => {
    const { calls, user } = await open({ extra: { [`POST /api${ISSUE}`]: { status: 201, body: DOC_VIEW } } });
    await user.click(screen.getByRole('button', { name: 'Nefiskalni račun' }));
    await waitFor(() => expect(navigation.go).toHaveBeenCalledTimes(1));
    // navigation is mocked, so the page is still here: its document buttons stay disabled.
    expect(screen.getByRole('button', { name: 'Nefiskalni račun' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Predračun' })).toBeDisabled();
    expect(postsTo(calls, ISSUE)).toHaveLength(1);
  });
});

describe('FolioView: overlapping reads', () => {
  it('a failure of an older read does not show an error once a newer read has answered', async () => {
    // StrictMode runs the load effect twice: read 1 fails late, read 2 succeeds at once.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    mockFetch(
      routes({
        extra: {
          [`GET /api/stays/${STAY}/folio`]: async () => {
            reads += 1;
            if (reads === 1) {
              await gate;
              return { status: 404, body: { code: 'stay_not_found', message: 'x', details: null } };
            }
            return { body: FOLIO };
          },
        },
      }),
    );
    render(
      <StrictMode>
        <FolioView stayId={STAY} />
      </StrictMode>,
    );
    await screen.findByText('Ukupno');
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Ukupno')).toBeInTheDocument();
  });
});
