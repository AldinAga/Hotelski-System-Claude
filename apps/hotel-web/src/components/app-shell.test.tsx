import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '@/lib/api';
import { apiError, mockFetch } from '@/test/fetch-mock';
import { AppShell } from './app-shell';

const licence = (state: string) => ({
  'GET /api/licence': { body: { activated: true, modules: ['hotel.core'], limits: {}, state } },
});

beforeEach(() => {
  vi.spyOn(navigation, 'go').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AppShell', () => {
  it('in safe mode (EXPIRED) "Nova rezervacija" in the menu is not a link; the other links stay', async () => {
    mockFetch(licence('EXPIRED'));
    render(<AppShell>sadržaj</AppShell>);
    // The banner proves the licence answer has arrived.
    await screen.findByRole('alert');
    await vi.waitFor(() => expect(screen.queryByRole('link', { name: 'Nova rezervacija' })).toBeNull());
    expect(screen.getByText('Nova rezervacija')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('link', { name: 'Kalendar' })).toHaveAttribute('href', '/kalendar');
  });

  it('with a valid licence it is a link to the new reservation form', async () => {
    const calls = mockFetch(licence('VALID'));
    render(<AppShell>sadržaj</AppShell>);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole('link', { name: 'Nova rezervacija' })).toHaveAttribute('href', '/rezervacije/nova');
  });

  describe('business menu', () => {
    const menu = (role: string | null) =>
      mockFetch({
        ...licence('VALID'),
        'GET /api/auth/me': role === null ? apiError(500, 'unknown') : { body: { role } },
        'GET /api/business-day': { body: { day: '2026-11-02', lagDays: 0 } },
      });

    it('owner and manager see Poslovni dan, Poslovanje and Pravni profil', async () => {
      for (const role of ['owner', 'manager']) {
        menu(role);
        const { unmount } = render(<AppShell>sadržaj</AppShell>);
        expect(await screen.findByRole('link', { name: 'Poslovni dan' })).toHaveAttribute('href', '/poslovni-dan');
        expect(screen.getByRole('link', { name: 'Poslovanje' })).toHaveAttribute('href', '/podesavanja/poslovanje');
        expect(screen.getByRole('link', { name: 'Pravni profil' })).toHaveAttribute('href', '/podesavanja/pravni-profil');
        // Let the answers land so nothing is still pending when the test ends.
        await screen.findByText(/^Poslovni dan: 2\.11\./);
        unmount();
      }
    });

    it('recepcionar ne vidi Poslovanje ni Pravni profil u meniju, ali vidi Poslovni dan', async () => {
      const calls = menu('receptionist');
      render(<AppShell>sadržaj</AppShell>);
      await vi.waitFor(() => expect(screen.queryByRole('link', { name: 'Poslovanje' })).toBeNull());
      expect(calls.some((c) => c.url === '/api/auth/me')).toBe(true);
      expect(screen.queryByRole('link', { name: 'Pravni profil' })).toBeNull();
      expect(screen.getByRole('link', { name: 'Poslovni dan' })).toBeInTheDocument();
      await screen.findByText(/^Poslovni dan: 2\.11\./);
    });

    it('housekeeping has no business day entry, no badge and no settings', async () => {
      menu('housekeeping');
      render(<AppShell>sadržaj</AppShell>);
      await vi.waitFor(() => expect(screen.queryByRole('link', { name: 'Poslovni dan' })).toBeNull());
      expect(screen.queryByRole('link', { name: 'Poslovanje' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'Pravni profil' })).toBeNull();
    });

    it('while the role is unknown the entries stay (the API still refuses what it must)', async () => {
      const calls = menu(null);
      render(<AppShell>sadržaj</AppShell>);
      await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/auth/me')).toBe(true));
      expect(screen.getByRole('link', { name: 'Poslovanje' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Pravni profil' })).toBeInTheDocument();
      await screen.findByText(/^Poslovni dan: 2\.11\./);
    });
  });
});
