import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FolioView } from '@/components/folio-view';
import { navigation } from '@/lib/api';
import { apiError, mockFetch } from '@/test/fetch-mock';
import FolioLayout from './layout';

const STAY = '66666666-6666-4666-8666-666666666666';

beforeEach(() => {
  vi.spyOn(navigation, 'go').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('/folio layout', () => {
  it('has the menu and the back-to-top button next to the folio page, which has its heading', async () => {
    mockFetch({
      'GET /api/licence': { body: { activated: true, modules: ['hotel.folio'], limits: {}, state: 'VALID' } },
      'GET /api/auth/me': { body: { role: 'owner' } },
      [`GET /api/stays/${STAY}/folio`]: apiError(404, 'stay_not_found'),
      [`GET /api/stays/${STAY}/folio/documents`]: apiError(404, 'stay_not_found'),
    });
    const { container } = render(
      <FolioLayout>
        <FolioView stayId={STAY} />
      </FolioLayout>,
    );
    await screen.findByRole('alert');
    expect(screen.getByRole('navigation', { name: 'Glavni meni' })).toBeInTheDocument();
    expect(screen.getByLabelText('Nazad na vrh', { selector: 'button' })).toHaveClass('back-to-top--app');
    expect(container.querySelector('main h1')).toHaveTextContent('Folio');
  });
});
