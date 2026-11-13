import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '@/lib/api';
import type { FolioDocument, FolioDocumentContent } from '@/lib/types';
import { apiError, mockFetch } from '@/test/fetch-mock';
import { DocumentView } from './document-view';

const ID = '77777777-7777-4777-8777-777777777777';

const CONTENT: FolioDocumentContent = {
  kind: 'receipt',
  number: 'N-2026-000012',
  issuedAt: '2026-11-03T13:05:00.000Z',
  businessDate: '2026-11-03',
  notice: 'Ovo nije fiskalni račun.',
  seller: {
    legalName: 'Vila Marija d.o.o.',
    taxId: '123456789',
    registryId: '12345678',
    address: 'Knez Mihailova 5',
    postalCode: '11000',
    city: 'Beograd',
    bankAccount: '160-0000000000000-00',
    vatPayer: true,
  },
  guest: { name: 'Petar Petrović', email: null },
  reservation: { number: 'R-2026-000007', arrival: '2026-11-02', departure: '2026-11-05', unit: 'Soba 101' },
  lines: [
    { description: 'Smeštaj 2.11.2026', night: '2026-11-02', amountMinor: 1_000_000, vatRateBp: 1000, expected: false },
    { description: 'Minibar', night: null, amountMinor: 120_000, vatRateBp: 2000, expected: false },
  ],
  payments: [{ method: 'card', amountMinor: 500_000, businessDate: '2026-11-03' }],
  totalMinor: 1_120_000,
  paidMinor: 500_000,
  dueMinor: 620_000,
  vat: [
    { rateBp: 1000, baseMinor: 909_091, vatMinor: 90_909 },
    { rateBp: 2000, baseMinor: 100_000, vatMinor: 20_000 },
  ],
};

function docOf(over: Partial<FolioDocumentContent> = {}, kind: FolioDocument['kind'] = 'receipt'): FolioDocument {
  const content = { ...CONTENT, kind, ...over };
  return { id: ID, kind, number: content.number, issuedAt: content.issuedAt, content };
}

function show(doc: FolioDocument) {
  mockFetch({ [`GET /api/folio-documents/${ID}`]: { body: doc } });
  render(<DocumentView id={ID} />);
}

beforeEach(() => {
  vi.spyOn(navigation, 'go').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DocumentView', () => {
  it('names the document and says in plain words that it is not a fiscal receipt', async () => {
    show(docOf());
    expect(await screen.findByRole('heading', { level: 1, name: 'Nefiskalni račun N-2026-000012' })).toBeInTheDocument();
    expect(screen.getByText('Ovo nije fiskalni račun.')).toBeInTheDocument();
    expect(screen.getByText('Izdato 3.11.2026 14:05 · poslovni datum 3.11.2026')).toBeInTheDocument();
  });

  it('shows the notice even if the stored snapshot lost its notice text', async () => {
    show(docOf({ notice: '' }));
    expect(await screen.findByText('Ovo nije fiskalni račun.')).toBeInTheDocument();
  });

  it('shows the seller, the guest, the stay, the lines and the payments', async () => {
    show(docOf());
    await screen.findByText('Nefiskalni račun N-2026-000012', { selector: 'h1' });
    const seller = screen.getByRole('region', { name: 'Izdavalac' });
    expect(within(seller).getByText('Vila Marija d.o.o.')).toBeInTheDocument();
    expect(within(seller).getByText('Knez Mihailova 5, 11000 Beograd')).toBeInTheDocument();
    expect(within(seller).getByText('PIB 123456789')).toBeInTheDocument();
    expect(within(seller).getByText('MB 12345678')).toBeInTheDocument();
    expect(within(seller).getByText('Račun 160-0000000000000-00')).toBeInTheDocument();
    const stay = screen.getByRole('region', { name: 'Gost i rezervacija' });
    expect(within(stay).getByText(/Petar Petrović/)).toBeInTheDocument();
    expect(within(stay).getByText(/R-2026-000007 · jedinica Soba 101/)).toBeInTheDocument();
    expect(within(stay).getByText(/2\.11\.2026 – 5\.11\.2026/)).toBeInTheDocument();
    const lines = screen.getByRole('table', { name: 'Stavke dokumenta' });
    expect(within(lines).getByText('Smeštaj 2.11.2026')).toBeInTheDocument();
    expect(within(lines).getByText('10.000,00 RSD')).toBeInTheDocument();
    expect(within(lines).getByText('1.200,00 RSD')).toBeInTheDocument();
    const payments = screen.getByRole('table', { name: 'Plaćanja' });
    expect(within(payments).getByText('Kartica · 3.11.2026')).toBeInTheDocument();
    expect(within(payments).getByText('5.000,00 RSD')).toBeInTheDocument();
  });

  it('shows the totals the server computed and the amount due', async () => {
    show(docOf());
    await screen.findByText('Ukupno');
    expect(screen.getByText('Ukupno').nextElementSibling).toHaveTextContent('11.200,00 RSD');
    expect(screen.getByText('Plaćeno').nextElementSibling).toHaveTextContent('5.000,00 RSD');
    expect(screen.getByText('Za uplatu').nextElementSibling).toHaveTextContent('6.200,00 RSD');
  });

  it('a negative amount due is a prepayment, shown as a positive amount', async () => {
    show(docOf({ dueMinor: -300_000 }));
    await screen.findByText('Preplata');
    // Exact text: toHaveTextContent would also accept "-3.000,00 RSD".
    expect(screen.getByText('Preplata').nextElementSibling?.textContent).toBe('3.000,00 RSD');
    expect(screen.queryByText('Za uplatu')).toBeNull();
  });

  it('shows the VAT recapitulation per rate when the document has one', async () => {
    show(docOf());
    const table = await screen.findByRole('table', { name: 'PDV rekapitulacija' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['10 %', '9.090,91 RSD', '909,09 RSD']);
    expect(within(rows[2]).getAllByRole('cell').map((c) => c.textContent)).toEqual(['20 %', '1.000,00 RSD', '200,00 RSD']);
  });

  it('has no VAT table when the document has none (seller not a VAT payer, or a line without a rate)', async () => {
    show(docOf({ vat: null }));
    await screen.findByText('Ukupno');
    expect(screen.queryByRole('table', { name: 'PDV rekapitulacija' })).toBeNull();
    expect(screen.queryByText(/PDV/)).toBeNull();
  });

  it('a null seller field does not show: no label, no "null", no gap (no legal profile yet)', async () => {
    show(
      docOf({
        seller: { legalName: null, taxId: null, registryId: null, address: null, postalCode: null, city: null, bankAccount: null, vatPayer: false },
        vat: null,
      }),
    );
    await screen.findByText('Ukupno');
    expect(screen.queryByRole('region', { name: 'Izdavalac' })).toBeNull();
    expect(screen.queryByText(/PIB|JMBG|MB |Račun /)).toBeNull();
    expect(document.body.textContent).not.toMatch(/null|undefined/);
  });

  it('a partly filled seller shows only what is there, and a masked JMBG is labelled JMBG', async () => {
    show(
      docOf({
        seller: {
          legalName: 'Marija Marić',
          taxId: null,
          registryId: '•••••••••1234',
          address: null,
          postalCode: '21000',
          city: 'Novi Sad',
          bankAccount: null,
          vatPayer: false,
        },
        vat: null,
      }),
    );
    const seller = await screen.findByRole('region', { name: 'Izdavalac' });
    expect(within(seller).getAllByRole('paragraph').map((p) => p.textContent)).toEqual([
      'Marija Marić',
      '21000 Novi Sad',
      'JMBG •••••••••1234',
    ]);
  });

  it('a pro forma marks the nights that are only expected, and says so', async () => {
    show(
      docOf(
        {
          number: 'P-2026-000004',
          lines: [
            { description: 'Smeštaj 2.11.2026', night: '2026-11-02', amountMinor: 1_000_000, vatRateBp: 1000, expected: false },
            { description: 'Smeštaj 3.11.2026', night: '2026-11-03', amountMinor: 1_000_000, vatRateBp: 1000, expected: true },
          ],
        },
        'proforma',
      ),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Predračun P-2026-000004' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Stavke dokumenta' });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]).queryByText('očekivano')).toBeNull();
    expect(within(rows[2]).getByText('očekivano')).toBeInTheDocument();
    expect(screen.getByText('Predračun uključuje noći koje još nisu proknjižene; one su označene kao očekivane.')).toBeInTheDocument();
    // The not-fiscal notice is on a pro forma too.
    expect(screen.getByText('Ovo nije fiskalni račun.')).toBeInTheDocument();
  });

  it('a receipt without expected nights has no such note', async () => {
    show(docOf());
    await screen.findByText('Ukupno');
    expect(screen.queryByText(/nisu proknjižene/)).toBeNull();
    expect(screen.queryByText('očekivano')).toBeNull();
  });

  it('Štampaj prints the page', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const user = userEvent.setup();
    show(docOf());
    await user.click(await screen.findByRole('button', { name: 'Štampaj' }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('prints A4 by default and an 80 mm roll when chosen', async () => {
    const user = userEvent.setup();
    show(docOf());
    const article = (await screen.findByRole('article')) as HTMLElement;
    expect(article).toHaveClass('doc--a4');
    expect(screen.getByRole('radio', { name: 'A4' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Termalni 80 mm' }));
    expect(article).toHaveClass('doc--thermal');
    expect(article).not.toHaveClass('doc--a4');
    expect(screen.getByRole('radio', { name: 'Termalni 80 mm' })).toBeChecked();
  });

  it('the toolbar is marked so the print stylesheet can hide it', async () => {
    show(docOf());
    const print = await screen.findByRole('button', { name: 'Štampaj' });
    expect(print.closest('.no-print')).not.toBeNull();
  });

  it('Nazad goes back in the history, or to the calendar when there is none', async () => {
    const user = userEvent.setup();
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    show(docOf());
    const button = await screen.findByRole('button', { name: '‹ Nazad' });
    const setLength = (n: number) => Object.defineProperty(window.history, 'length', { configurable: true, get: () => n });
    try {
      setLength(3);
      await user.click(button);
      expect(back).toHaveBeenCalledTimes(1);
      expect(navigation.go).not.toHaveBeenCalled();
      setLength(1);
      await user.click(button);
      expect(back).toHaveBeenCalledTimes(1);
      expect(navigation.go).toHaveBeenCalledWith('/kalendar');
    } finally {
      Reflect.deleteProperty(window.history, 'length');
    }
  });

  it('a document that does not exist shows the dictionary message', async () => {
    mockFetch({ [`GET /api/folio-documents/${ID}`]: apiError(404, 'document_not_found') });
    render(<DocumentView id={ID} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Dokument ne postoji. Osvežite stranicu.');
    expect(screen.queryByRole('article')).toBeNull();
    // The page keeps its heading, which the back-to-top button moves focus to.
    expect(screen.getByRole('heading', { level: 1, name: 'Dokument' })).toBeInTheDocument();
  });

  it('the document heading can take focus (the back-to-top button moves it there)', async () => {
    show(docOf());
    expect(await screen.findByRole('heading', { level: 1, name: 'Nefiskalni račun N-2026-000012' })).toHaveAttribute('tabindex', '-1');
  });
});

describe('print stylesheet', () => {
  const css = readFileSync(resolve(__dirname, '../app/globals.css'), 'utf8');
  const printBlock = css.slice(css.lastIndexOf('@media print'));

  it('hides the menu, the licence banner, the back-to-top button, the toolbar and dialogs when printing', () => {
    const hidden = /([^{}]+)\{\s*display:\s*none\s*!important;?\s*\}/.exec(printBlock)?.[1] ?? '';
    for (const selector of ['.topnav', '.banner', '.back-to-top', '.no-print', '.modal-backdrop']) {
      expect(hidden, selector).toContain(selector);
    }
  });

  it('prints on A4 by default and on an 80 mm roll for the thermal layout', () => {
    expect(css).toMatch(/@page\s*\{[^}]*size:\s*A4/);
    expect(css).toMatch(/@page\s+roll\s*\{[^}]*size:\s*80mm\s+auto/);
    expect(css).toMatch(/\.doc--thermal\s*\{[^}]*page:\s*roll/);
  });

  it('prints the document on white without its screen frame', () => {
    expect(printBlock).toMatch(/background:\s*#ffffff\s*!important/);
    expect(printBlock).toMatch(/\.doc\s*\{[^}]*border:\s*0/);
  });
});
