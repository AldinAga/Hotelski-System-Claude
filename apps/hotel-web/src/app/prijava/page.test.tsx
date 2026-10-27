import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '@/lib/api';
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
});

describe('/prijava', () => {
  it('menadžer bez TOTP-a dobija polje za kod posle totp_required', async () => {
    const calls = mockFetch({
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
    mockFetch({ 'GET /api/setup/status': { body: { activated: false, hasOwner: false, hasProperty: false } } });
    render(<SignInPage />);
    await vi.waitFor(() => expect(navigation.go).toHaveBeenCalledWith('/aktivacija'));
  });
});
