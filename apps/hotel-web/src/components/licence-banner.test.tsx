import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '@/lib/api';
import { mockFetch } from '@/test/fetch-mock';
import { LicenceBanner } from './licence-banner';

const BASE = { activated: true, modules: ['hotel.core'], limits: {} };

beforeEach(() => {
  vi.spyOn(navigation, 'go').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('LicenceBanner', () => {
  it('LicenceBanner u EXPIRED prikazuje tekst sigurnog režima', async () => {
    mockFetch({ 'GET /api/licence': { body: { ...BASE, state: 'EXPIRED', validUntil: '2026-09-01T00:00:00Z' } } });
    render(<LicenceBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Licenca je istekla. Sistem radi u sigurnom režimu: pregled je dozvoljen, izmene nisu.',
    );
  });

  it('GRACE says until when the system keeps working', async () => {
    mockFetch({
      'GET /api/licence': {
        body: { ...BASE, state: 'GRACE', validUntil: '2026-10-20T10:00:00Z', graceUntil: '2026-11-03T10:00:00Z' },
      },
    });
    render(<LicenceBanner />);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Licenca je istekla. Sistem radi bez ograničenja do 3.11.2026. Obnovite licencu na vreme.',
    );
  });

  it('shows nothing while the licence is valid', async () => {
    const calls = mockFetch({ 'GET /api/licence': { body: { ...BASE, state: 'VALID' } } });
    const { container } = render(<LicenceBanner />);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
  });
});
