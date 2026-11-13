import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentView } from '@/components/document-view';
import { navigation } from '@/lib/api';
import { mockFetch } from '@/test/fetch-mock';
import DocumentsLayout from './layout';

const ID = '77777777-7777-4777-8777-777777777777';

beforeEach(() => {
  vi.spyOn(navigation, 'go').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('/dokumenti layout', () => {
  it('has the menu and the back-to-top button, and the document page has the heading that button focuses (F16)', async () => {
    mockFetch({
      'GET /api/licence': { body: { activated: true, modules: ['hotel.folio'], limits: {}, state: 'VALID' } },
      [`GET /api/folio-documents/${ID}`]: {
        body: {
          id: ID,
          kind: 'receipt',
          number: 'N-2026-000001',
          issuedAt: '2026-11-03T10:00:00.000Z',
          content: {
            kind: 'receipt',
            number: 'N-2026-000001',
            issuedAt: '2026-11-03T10:00:00.000Z',
            businessDate: '2026-11-03',
            notice: 'Ovo nije fiskalni račun.',
            seller: { legalName: null, taxId: null, registryId: null, address: null, postalCode: null, city: null, bankAccount: null, vatPayer: false },
            guest: { name: 'Petar Petrović', email: null },
            reservation: { number: 'R-1', arrival: '2026-11-02', departure: '2026-11-03', unit: null },
            lines: [],
            payments: [],
            totalMinor: 0,
            paidMinor: 0,
            dueMinor: 0,
            vat: null,
          },
        },
      },
    });
    const { container } = render(
      <DocumentsLayout>
        <DocumentView id={ID} />
      </DocumentsLayout>,
    );
    await screen.findByRole('heading', { level: 1, name: 'Nefiskalni račun N-2026-000001' });
    expect(screen.getByRole('navigation', { name: 'Glavni meni' })).toBeInTheDocument();
    // aria-hidden until the page is scrolled, so it is found by its label, not by role.
    const toTop = screen.getByLabelText('Nazad na vrh', { selector: 'button' });
    expect(toTop).toHaveClass('back-to-top', 'back-to-top--app');
    expect(container.querySelector('main h1')).not.toBeNull();
  });
});
