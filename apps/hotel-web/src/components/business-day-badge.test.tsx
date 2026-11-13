import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { announceBusinessDayChange } from '@/lib/business';
import { apiError, mockFetch } from '@/test/fetch-mock';
import { BusinessDayBadge } from './business-day-badge';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BusinessDayBadge', () => {
  it('shows the open day as D.M.', async () => {
    mockFetch({ 'GET /api/business-day': { body: { day: '2026-11-02', lagDays: 0 } } });
    render(<BusinessDayBadge />);
    expect(await screen.findByText('Poslovni dan: 2.11.')).toHaveAttribute('data-late', 'false');
  });

  it('is red and says how late the day is for the screen reader when the day lags', async () => {
    mockFetch({ 'GET /api/business-day': { body: { day: '2026-11-02', lagDays: 2 } } });
    render(<BusinessDayBadge />);
    const badge = await screen.findByText('Poslovni dan: 2.11.');
    expect(badge).toHaveAttribute('data-late', 'true');
    expect(badge).toHaveClass('is-late');
    expect(badge).toHaveTextContent('Poslovni dan: 2.11. (kasni 2 dana)');
  });

  it('is not red after an evening close (lagDays below zero)', async () => {
    mockFetch({ 'GET /api/business-day': { body: { day: '2026-11-04', lagDays: -1 } } });
    render(<BusinessDayBadge />);
    const badge = await screen.findByText('Poslovni dan: 4.11.');
    expect(badge).toHaveAttribute('data-late', 'false');
    expect(badge).not.toHaveTextContent('kasni');
  });

  it('shows nothing when the day cannot be read', async () => {
    const calls = mockFetch({ 'GET /api/business-day': apiError(403, 'forbidden_role') });
    const { container } = render(<BusinessDayBadge />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
  });

  it('reads the day again when a screen announces a close, so it never keeps the old day', async () => {
    let day = '2026-11-02';
    mockFetch({ 'GET /api/business-day': () => ({ body: { day, lagDays: 1 } }) });
    render(<BusinessDayBadge />);
    await screen.findByText('Poslovni dan: 2.11.');
    day = '2026-11-03';
    act(() => announceBusinessDayChange());
    expect(await screen.findByText('Poslovni dan: 3.11.')).toBeInTheDocument();
    expect(screen.queryByText('Poslovni dan: 2.11.')).toBeNull();
  });

  it('drops the old day when the next read fails instead of keeping a day it cannot vouch for', async () => {
    let fail = false;
    mockFetch({ 'GET /api/business-day': () => (fail ? apiError(500, 'unknown') : { body: { day: '2026-11-02', lagDays: 0 } }) });
    const { container } = render(<BusinessDayBadge />);
    await screen.findByText('Poslovni dan: 2.11.');
    fail = true;
    act(() => announceBusinessDayChange());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('an older answer that arrives after a newer one does not paint', async () => {
    let releaseOld: () => void = () => undefined;
    const old = new Promise<void>((resolve) => (releaseOld = resolve));
    let n = 0;
    mockFetch({
      'GET /api/business-day': async () => {
        if (n++ === 0) {
          await old;
          return { body: { day: '2026-11-02', lagDays: 1 } };
        }
        return { body: { day: '2026-11-03', lagDays: 1 } };
      },
    });
    render(<BusinessDayBadge />);
    // The close is announced while the first read is still on its way.
    act(() => announceBusinessDayChange());
    await screen.findByText('Poslovni dan: 3.11.');
    await act(async () => {
      releaseOld();
      await old;
      // Let the old answer travel through fetch and api() to the badge.
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(screen.getByText('Poslovni dan: 3.11.')).toBeInTheDocument();
    expect(screen.queryByText('Poslovni dan: 2.11.')).toBeNull();
  });

  it('stops listening when it goes away', async () => {
    const calls = mockFetch({ 'GET /api/business-day': { body: { day: '2026-11-02', lagDays: 0 } } });
    const { unmount } = render(<BusinessDayBadge />);
    await screen.findByText('Poslovni dan: 2.11.');
    unmount();
    act(() => announceBusinessDayChange());
    expect(calls).toHaveLength(1);
  });
});
