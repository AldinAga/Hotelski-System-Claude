import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '@/lib/api';
import { mockFetch } from '@/test/fetch-mock';
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
});
