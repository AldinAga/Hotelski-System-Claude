import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '@/lib/api';
import { resetTurnstileLoader, type TurnstileRenderOptions } from '@/lib/turnstile';
import { apiError, mockFetch, type Call } from '@/test/fetch-mock';
import SignInPage from './page';

const USER = { id: 'u1', email: 'menadzer@hotel.rs', name: 'Mina', role: 'manager' };

beforeEach(() => {
  vi.spyOn(navigation, 'go').mockImplementation(() => undefined);
  window.history.replaceState(null, '', '/prijava');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetTurnstileLoader();
});

const NO_CAPTCHA = { 'GET /api/auth/config': { body: { turnstileSiteKey: null } } };
const SITE_KEY = '0x4AAAAAAA-site';
const WAIT = 'Sačekajte da se završi provera da niste robot';

function turnstileScripts(): HTMLScriptElement[] {
  return [...document.querySelectorAll<HTMLScriptElement>('script')].filter((s) =>
    s.src.startsWith('https://challenges.cloudflare.com/'),
  );
}

/** Stands in for Cloudflare's script: window.turnstile appears and the tag fires load. */
function cloudflareLoads() {
  const rendered: Array<{ el: HTMLElement; options: TurnstileRenderOptions }> = [];
  const turnstile = {
    render: vi.fn((el: HTMLElement, options: TurnstileRenderOptions) => {
      rendered.push({ el, options });
      return 'widget-1';
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  window.turnstile = turnstile;
  const [script] = turnstileScripts();
  act(() => script.dispatchEvent(new Event('load')));
  return { turnstile, rendered };
}

describe('/prijava', () => {
  it('menadžer bez TOTP-a dobija polje za kod posle totp_required', async () => {
    const calls = mockFetch({
      ...NO_CAPTCHA,
      'GET /api/setup/status': apiError(410, 'setup_done'),
      'POST /api/auth/login': (c: Call) =>
        (c.body as { totp?: string }).totp === '654321' ? { body: USER } : apiError(401, 'totp_required'),
    });
    const user = userEvent.setup();
    render(<SignInPage />);

    expect(screen.queryByLabelText('Kod iz aplikacije')).toBeNull();
    await user.type(screen.getByLabelText('E-adresa'), 'menadzer@hotel.rs');
    await user.type(screen.getByLabelText('Lozinka'), 'tajna-lozinka-1');
    await user.click(screen.getByRole('button', { name: 'Prijavi se' }));

    const code = await screen.findByLabelText('Kod iz aplikacije');
    expect(screen.getByRole('alert')).toHaveTextContent('Unesite šestocifreni kod iz aplikacije za autentifikaciju.');
    expect(navigation.go).not.toHaveBeenCalled();

    await user.type(code, '654321');
    await user.click(screen.getByRole('button', { name: 'Prijavi se' }));

    await vi.waitFor(() => expect(navigation.go).toHaveBeenCalledWith('/'));
    const logins = calls.filter((c) => c.url === '/api/auth/login');
    expect(logins.map((c) => c.body)).toEqual([
      { email: 'menadzer@hotel.rs', password: 'tajna-lozinka-1' },
      { email: 'menadzer@hotel.rs', password: 'tajna-lozinka-1', totp: '654321' },
    ]);
  });

  it('wrong credentials show the dictionary message and no code field', async () => {
    mockFetch({
      ...NO_CAPTCHA,
      'GET /api/setup/status': apiError(410, 'setup_done'),
      'POST /api/auth/login': apiError(401, 'invalid_credentials', 'server text'),
    });
    const user = userEvent.setup();
    render(<SignInPage />);
    await user.type(screen.getByLabelText('E-adresa'), 'a@b.rs');
    await user.type(screen.getByLabelText('Lozinka'), 'x');
    await user.click(screen.getByRole('button', { name: 'Prijavi se' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Neispravna e-adresa ili lozinka.');
    expect(screen.queryByLabelText('Kod iz aplikacije')).toBeNull();
  });

  it('an installation still in setup sends the visitor to /aktivacija', async () => {
    mockFetch({
      ...NO_CAPTCHA,
      'GET /api/setup/status': { body: { activated: false, hasOwner: false, hasProperty: false } },
    });
    render(<SignInPage />);
    await vi.waitFor(() => expect(navigation.go).toHaveBeenCalledWith('/aktivacija'));
  });

  describe('Turnstile', () => {
    it('without a site key: no Cloudflare script, no widget, and the login body has no token', async () => {
      const calls = mockFetch({
        ...NO_CAPTCHA,
        'GET /api/setup/status': apiError(410, 'setup_done'),
        'POST /api/auth/login': { body: USER },
      });
      const user = userEvent.setup();
      render(<SignInPage />);
      await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/auth/config')).toBe(true));

      await user.type(screen.getByLabelText('E-adresa'), 'a@b.rs');
      await user.type(screen.getByLabelText('Lozinka'), 'x');
      await user.click(screen.getByRole('button', { name: 'Prijavi se' }));

      await vi.waitFor(() => expect(navigation.go).toHaveBeenCalledWith('/'));
      expect(calls.find((c) => c.url === '/api/auth/login')?.body).toEqual({ email: 'a@b.rs', password: 'x' });
      expect(turnstileScripts()).toHaveLength(0);
      expect(screen.queryByTestId('turnstile')).toBeNull();
    });

    it('when /auth/config fails, the page works as before (no script, no token)', async () => {
      const calls = mockFetch({
        'GET /api/auth/config': apiError(500, 'internal'),
        'GET /api/setup/status': apiError(410, 'setup_done'),
        'POST /api/auth/login': { body: USER },
      });
      const user = userEvent.setup();
      render(<SignInPage />);
      await vi.waitFor(() => expect(calls.some((c) => c.url === '/api/auth/config')).toBe(true));
      await user.type(screen.getByLabelText('E-adresa'), 'a@b.rs');
      await user.type(screen.getByLabelText('Lozinka'), 'x');
      await user.click(screen.getByRole('button', { name: 'Prijavi se' }));
      await vi.waitFor(() => expect(navigation.go).toHaveBeenCalledWith('/'));
      expect(turnstileScripts()).toHaveLength(0);
    });

    it('with a site key: loads the script once, renders the widget and sends its token', async () => {
      const calls = mockFetch({
        'GET /api/auth/config': { body: { turnstileSiteKey: SITE_KEY } },
        'GET /api/setup/status': apiError(410, 'setup_done'),
        'POST /api/auth/login': { body: USER },
      });
      const user = userEvent.setup();
      render(<SignInPage />);

      await waitFor(() => expect(turnstileScripts()).toHaveLength(1));
      expect(turnstileScripts()[0].src).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
      const { turnstile, rendered } = cloudflareLoads();
      await vi.waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(1));
      expect(rendered[0].el).toBe(screen.getByTestId('turnstile'));
      expect(rendered[0].options).toMatchObject({ sitekey: SITE_KEY, action: 'login', theme: 'auto', size: 'flexible' });

      act(() => rendered[0].options.callback!('token-abc'));
      await user.type(screen.getByLabelText('E-adresa'), 'a@b.rs');
      await user.type(screen.getByLabelText('Lozinka'), 'x');
      await user.click(screen.getByRole('button', { name: 'Prijavi se' }));

      await vi.waitFor(() => expect(navigation.go).toHaveBeenCalledWith('/'));
      expect(calls.find((c) => c.url === '/api/auth/login')?.body).toEqual({
        email: 'a@b.rs',
        password: 'x',
        turnstileToken: 'token-abc',
      });
      expect(turnstileScripts()).toHaveLength(1);
    });

    it('mounted twice (StrictMode), the page still adds the script once and renders one widget', async () => {
      mockFetch({
        'GET /api/auth/config': { body: { turnstileSiteKey: SITE_KEY } },
        'GET /api/setup/status': apiError(410, 'setup_done'),
      });
      render(
        <StrictMode>
          <SignInPage />
        </StrictMode>,
      );
      await waitFor(() => expect(turnstileScripts().length).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 20));
      expect(turnstileScripts()).toHaveLength(1);
      const { turnstile } = cloudflareLoads();
      await vi.waitFor(() => expect(turnstile.render).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(turnstile.render.mock.calls.length - turnstile.remove.mock.calls.length).toBe(1);
    });

    it('before the check finishes, the form asks to wait and sends nothing', async () => {
      const calls = mockFetch({
        'GET /api/auth/config': { body: { turnstileSiteKey: SITE_KEY } },
        'GET /api/setup/status': apiError(410, 'setup_done'),
        'POST /api/auth/login': { body: USER },
      });
      const user = userEvent.setup();
      render(<SignInPage />);
      await waitFor(() => expect(turnstileScripts()).toHaveLength(1));
      const { turnstile } = cloudflareLoads();
      await vi.waitFor(() => expect(turnstile.render).toHaveBeenCalled());

      await user.type(screen.getByLabelText('E-adresa'), 'a@b.rs');
      await user.type(screen.getByLabelText('Lozinka'), 'x');
      await user.click(screen.getByRole('button', { name: 'Prijavi se' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(WAIT);
      expect(calls.some((c) => c.url === '/api/auth/login')).toBe(false);
    });

    it.each([
      ['invalid_credentials', 401, 'Neispravna e-adresa ili lozinka.'],
      ['captcha_failed', 403, 'Provera da niste robot nije prošla. Pokušajte ponovo.'],
      ['captcha_unavailable', 503, 'Provera da niste robot trenutno nije dostupna. Pokušajte ponovo za minut.'],
    ])('after a failed login (%s) the widget is reset and its used token is not sent again', async (code, status, text) => {
      const calls = mockFetch({
        'GET /api/auth/config': { body: { turnstileSiteKey: SITE_KEY } },
        'GET /api/setup/status': apiError(410, 'setup_done'),
        'POST /api/auth/login': apiError(status, code, 'server text'),
      });
      const logins = () => calls.filter((c) => c.url === '/api/auth/login');
      const user = userEvent.setup();
      render(<SignInPage />);
      await waitFor(() => expect(turnstileScripts()).toHaveLength(1));
      const { turnstile, rendered } = cloudflareLoads();
      await vi.waitFor(() => expect(turnstile.render).toHaveBeenCalled());
      act(() => rendered[0].options.callback!('token-1'));

      await user.type(screen.getByLabelText('E-adresa'), 'a@b.rs');
      await user.type(screen.getByLabelText('Lozinka'), 'x');
      await user.click(screen.getByRole('button', { name: 'Prijavi se' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(text);
      expect(turnstile.reset).toHaveBeenCalledWith('widget-1');

      // The used token is gone: a second try waits for a fresh one.
      await user.click(screen.getByRole('button', { name: 'Prijavi se' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(WAIT);
      expect(logins()).toHaveLength(1);

      act(() => rendered[0].options.callback!('token-2'));
      await user.click(screen.getByRole('button', { name: 'Prijavi se' }));
      await vi.waitFor(() => expect(logins()).toHaveLength(2));
      expect((logins()[1].body as { turnstileToken: string }).turnstileToken).toBe('token-2');
    });

    it('an expired token is dropped', async () => {
      const calls = mockFetch({
        'GET /api/auth/config': { body: { turnstileSiteKey: SITE_KEY } },
        'GET /api/setup/status': apiError(410, 'setup_done'),
        'POST /api/auth/login': { body: USER },
      });
      const user = userEvent.setup();
      render(<SignInPage />);
      await waitFor(() => expect(turnstileScripts()).toHaveLength(1));
      const { turnstile, rendered } = cloudflareLoads();
      await vi.waitFor(() => expect(turnstile.render).toHaveBeenCalled());
      act(() => rendered[0].options.callback!('token-1'));
      act(() => rendered[0].options['expired-callback']!());

      await user.type(screen.getByLabelText('E-adresa'), 'a@b.rs');
      await user.type(screen.getByLabelText('Lozinka'), 'x');
      await user.click(screen.getByRole('button', { name: 'Prijavi se' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(WAIT);
      expect(calls.some((c) => c.url === '/api/auth/login')).toBe(false);
    });

    it('a blocked Cloudflare script shows a plain message', async () => {
      mockFetch({
        'GET /api/auth/config': { body: { turnstileSiteKey: SITE_KEY } },
        'GET /api/setup/status': apiError(410, 'setup_done'),
      });
      render(<SignInPage />);
      await waitFor(() => expect(turnstileScripts()).toHaveLength(1));
      act(() => turnstileScripts()[0].dispatchEvent(new Event('error')));
      expect(await screen.findByRole('alert')).toHaveTextContent('Provera da niste robot nije mogla da se učita');
    });
  });
});
