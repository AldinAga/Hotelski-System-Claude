import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '@/lib/api';
import { apiError, mockFetch } from '@/test/fetch-mock';
import ActivationPage from './page';

const OPEN = { body: { activated: false, hasOwner: false, hasProperty: false } };

beforeEach(() => {
  vi.spyOn(navigation, 'go').mockImplementation(() => undefined);
  window.history.replaceState(null, '', '/aktivacija');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('/aktivacija', () => {
  it('aktivacija: pogrešan setup kod prikazuje poruku iz rečnika', async () => {
    const calls = mockFetch({
      'GET /api/setup/status': OPEN,
      'POST /api/setup/activate': apiError(403, 'setup_token_invalid', 'server text'),
    });
    const user = userEvent.setup();
    render(<ActivationPage />);

    await user.type(await screen.findByLabelText('Kod za prvo podešavanje'), 'WRONG-CODE');
    await user.type(screen.getByLabelText('Aktivacioni kod'), 'ACT-123');
    await user.click(screen.getByRole('button', { name: 'Aktiviraj' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Kod za prvo podešavanje nije ispravan. Prepišite ga iz loga servera (hotel-api).',
    );
    expect(screen.queryByText('server text')).toBeNull();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ setupToken: 'WRONG-CODE', code: 'ACT-123' });
    // Still on step 1.
    expect(screen.getByLabelText('Aktivacioni kod')).toBeInTheDocument();
  });

  it('walks activation, owner and the first TOTP code (typed as the app shows it, "123 456"); the QR comes from totpUri', async () => {
    const totpUri = 'otpauth://totp/Hotel:vlasnik%40hotel.rs?secret=JBSWY3DPEHPK3PXP&issuer=Hotel';
    const calls = mockFetch({
      'GET /api/setup/status': OPEN,
      'POST /api/setup/activate': { body: { activated: true } },
      'POST /api/setup/owner': { status: 201, body: { totpUri } },
      'POST /api/setup/confirm': { body: { done: true } },
    });
    const user = userEvent.setup();
    render(<ActivationPage />);

    await user.type(await screen.findByLabelText('Kod za prvo podešavanje'), 'ABCD-EFGH-JKLM');
    await user.type(screen.getByLabelText('Aktivacioni kod'), 'ACT-123');
    await user.click(screen.getByRole('button', { name: 'Aktiviraj' }));

    await user.type(await screen.findByLabelText('Naziv objekta'), 'Vila Sunce');
    await user.selectOptions(screen.getByLabelText('Pravni oblik'), 'entrepreneur');
    await user.type(screen.getByLabelText('Ime i prezime vlasnika'), 'Pera Perić');
    await user.type(screen.getByLabelText('E-adresa'), 'vlasnik@hotel.rs');
    await user.type(screen.getByLabelText('Lozinka'), 'dugacka-lozinka-1');
    await user.type(screen.getByLabelText('Ponovite lozinku'), 'dugacka-lozinka-1');
    await user.click(screen.getByRole('button', { name: 'Nastavi' }));

    expect(await screen.findByRole('img', { name: 'QR kod za aplikaciju za autentifikaciju' })).toBeInTheDocument();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Kod iz aplikacije'), '123 456');
    await user.click(screen.getByRole('button', { name: 'Potvrdi' }));

    expect(await screen.findByText(/Podešavanje je završeno/)).toBeInTheDocument();
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url)).toEqual(['/api/setup/activate', '/api/setup/owner', '/api/setup/confirm']);
    expect(posts[1].body).toEqual({
      setupToken: 'ABCD-EFGH-JKLM',
      propertyName: 'Vila Sunce',
      legalKind: 'entrepreneur',
      name: 'Pera Perić',
      email: 'vlasnik@hotel.rs',
      password: 'dugacka-lozinka-1',
    });
    expect(posts[2].body).toEqual({ setupToken: 'ABCD-EFGH-JKLM', totp: '123456' });
  });

  it('does not send the owner step when the passwords differ', async () => {
    const calls = mockFetch({
      'GET /api/setup/status': { body: { activated: true, hasOwner: false, hasProperty: false } },
    });
    const user = userEvent.setup();
    render(<ActivationPage />);

    await user.type(await screen.findByLabelText('Kod za prvo podešavanje'), 'ABCD');
    await user.click(screen.getByRole('button', { name: 'Nastavi' }));
    await user.type(await screen.findByLabelText('Naziv objekta'), 'Vila');
    await user.type(screen.getByLabelText('Ime i prezime vlasnika'), 'Pera');
    await user.type(screen.getByLabelText('E-adresa'), 'a@b.rs');
    await user.type(screen.getByLabelText('Lozinka'), 'dugacka-lozinka-1');
    await user.type(screen.getByLabelText('Ponovite lozinku'), 'dugacka-lozinka-2');
    await user.click(screen.getByRole('button', { name: 'Nastavi' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Lozinke se ne poklapaju.');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('410 on /setup/status: already set up, links to sign-in and does not loop', async () => {
    mockFetch({ 'GET /api/setup/status': apiError(410, 'setup_done') });
    render(<ActivationPage />);
    expect(await screen.findByText('Prvo podešavanje je već završeno.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Prijava' })).toHaveAttribute('href', '/prijava');
    expect(navigation.go).not.toHaveBeenCalled();
  });
});
