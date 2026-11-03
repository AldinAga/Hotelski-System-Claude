import { act, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '@/test/fetch-mock';
import { AppShell } from './app-shell';
import { BackToTop } from './back-to-top';

const licence = (state: string) => ({
  'GET /api/licence': { body: { activated: true, modules: ['hotel.core'], limits: {}, state } },
});

/**
 * While hidden the button is aria-hidden, so its accessible name is empty and
 * getByRole({ name, hidden: true }) cannot find it; the aria-label still can.
 */
function hiddenButton() {
  return screen.getByLabelText('Nazad na vrh', { selector: 'button' });
}

function setScroll(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
  act(() => {
    window.dispatchEvent(new Event('scroll'));
  });
}

function mockReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: reduce && q.includes('prefers-reduced-motion'),
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('BackToTop', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
    setScroll(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('stays hidden and out of the tab order until the page scrolls past the first screen', () => {
    render(<BackToTop variant="app" />);
    const button = hiddenButton();
    expect(button).toHaveAttribute('tabindex', '-1');
    expect(button).toHaveAttribute('aria-hidden', 'true');
    setScroll(800);
    expect(button).toHaveAttribute('tabindex', '-1');
    setScroll(801);
    expect(button).toHaveAttribute('tabindex', '0');
    expect(button).not.toHaveAttribute('aria-hidden');
    expect(button).toHaveClass('back-to-top', 'back-to-top--app', 'is-visible');
  });

  it('the portal variant keeps its own look without the app class', () => {
    render(<BackToTop />);
    const button = hiddenButton();
    expect(button).toHaveClass('back-to-top');
    expect(button).not.toHaveClass('back-to-top--app');
  });

  it('scrolls smoothly and moves focus to the page heading, even one without tabIndex', () => {
    mockReducedMotion(false);
    render(
      <main>
        <h1>Kalendar</h1>
        <BackToTop variant="app" />
      </main>,
    );
    setScroll(2000);
    fireEvent.click(screen.getByRole('button', { name: 'Nazad na vrh' }));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Kalendar' }));
  });

  it('prefers the heading inside main over an earlier h1 outside it', () => {
    mockReducedMotion(false);
    render(
      <>
        <h1>Logo</h1>
        <main>
          <h1>Cene</h1>
          <BackToTop variant="app" />
        </main>
      </>,
    );
    setScroll(2000);
    fireEvent.click(screen.getByRole('button', { name: 'Nazad na vrh' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Cene' }));
  });

  it('with prefers-reduced-motion it jumps without animation', () => {
    mockReducedMotion(true);
    render(<BackToTop variant="app" />);
    setScroll(2000);
    fireEvent.click(screen.getByRole('button', { name: 'Nazad na vrh' }));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });

  it('every signed-in screen gets it through AppShell', async () => {
    const calls = mockFetch(licence('VALID'));
    render(
      <AppShell>
        <h1>Jedinice</h1>
      </AppShell>,
    );
    expect(hiddenButton()).toHaveClass('back-to-top--app');
    // Let the licence answer land so no state update escapes the test.
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
  });

  it('the app variant uses only app tokens, undoes the portal glass and has a visible focus ring', () => {
    const css = readFileSync(join(__dirname, '../app/globals.css'), 'utf8');
    const app = css.match(/\.back-to-top--app\s*\{[^}]*\}/g) ?? [];
    expect(app.length).toBeGreaterThanOrEqual(1);
    for (const block of app) {
      expect(block).not.toMatch(/--p-/);
      expect(block).toMatch(/var\(--surface\)/);
    }
    // The base .back-to-top rule carries portal tokens; the variant must override each one.
    const variant = app.join('\n');
    expect(variant).toMatch(/(^|[\s;{])border:\s*1px solid var\(--line\)/);
    expect(variant).toMatch(/(^|[\s;{])background:\s*var\(--surface\)/);
    expect(variant).toMatch(/(^|[\s;{])color:\s*var\(--text\)/);
    expect(variant).toMatch(/(^|[\s;{])box-shadow:\s*[^;]+;/);
    expect(variant).toMatch(/(^|[\s;{])backdrop-filter:\s*none/);
    expect(variant).toMatch(/-webkit-backdrop-filter:\s*none/);
    expect(css).toMatch(/\.back-to-top:focus-visible\s*\{[^}]*outline:\s*3px solid/);
    expect(css).toMatch(/\.back-to-top--app:focus-visible\s*\{[^}]*var\(--accent\)/);
  });
});
