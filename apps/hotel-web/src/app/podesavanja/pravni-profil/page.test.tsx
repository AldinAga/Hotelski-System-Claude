import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '@/lib/api';
import type { LegalProfile } from '@/lib/business';
import { apiError, mockFetch, type Call } from '@/test/fetch-mock';
import LegalProfilePage from './page';

const NOTICE = 'Fiskalizacija još nije uključena; plaćanja se beleže bez fiskalnog računa.';

const EMPTY: LegalProfile = {
  kind: null,
  legalName: null,
  taxId: null,
  registryId: null,
  vatPayer: false,
  address: null,
  postalCode: null,
  city: null,
  activityCode: null,
  bankAccount: null,
  email: null,
  phone: null,
  accommodationCategory: null,
  categorizationNumber: null,
  fiscalComplianceMode: null,
  fiscalNotice: null,
  complete: false,
  missing: ['legalName', 'address', 'city', 'taxId', 'registryId'],
};

const COMPANY: LegalProfile = {
  kind: 'legal_entity',
  legalName: 'Hotel Demo d.o.o.',
  taxId: '100002887',
  registryId: '07036540',
  vatPayer: true,
  address: 'Knez Mihailova 1',
  postalCode: '11000',
  city: 'Beograd',
  activityCode: '5510',
  bankAccount: '160-0000000123456-78',
  email: 'racun@demo.rs',
  phone: '+381 11 123 456',
  accommodationCategory: 'hotel',
  categorizationNumber: '12/2026',
  fiscalComplianceMode: 'required',
  fiscalNotice: 'not_available_yet',
  complete: true,
  missing: [],
};

const PERSON: LegalProfile = {
  ...COMPANY,
  kind: 'natural_person',
  legalName: 'Petar Petrović',
  taxId: null,
  registryId: '•••••••••0008',
  vatPayer: false,
  fiscalComplianceMode: 'disabled',
  fiscalNotice: null,
};

type Route = Parameters<typeof mockFetch>[0][string];

function setup(profile: LegalProfile, extra: Record<string, Route> = {}, over: { state?: string; role?: string } = {}) {
  return mockFetch({
    'GET /api/licence': { body: { activated: true, modules: ['hotel.core'], limits: {}, state: over.state ?? 'VALID' } },
    'GET /api/auth/me': { body: { role: over.role ?? 'owner' } },
    'GET /api/legal-profile': { body: profile },
    ...extra,
  });
}

const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT');
const field = (name: string) => screen.getByLabelText(name);
const save = () => screen.getByRole('button', { name: 'Sačuvaj' });

async function open() {
  render(<LegalProfilePage />);
  await screen.findByRole('form', { name: 'Pravni profil objekta' });
}

async function fill(user: ReturnType<typeof userEvent.setup>, label: string, text: string) {
  await user.clear(field(label));
  if (text) await user.type(field(label), text);
}

beforeEach(() => {
  vi.spyOn(navigation, 'go').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Pravni profil: showing the profile', () => {
  it('shows a saved company: the kind is fixed, every field is filled, the fiscal notice is up', async () => {
    setup(COMPANY);
    await open();
    expect(screen.getByText('Pravno lice')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(field('Pun naziv')).toHaveValue('Hotel Demo d.o.o.');
    expect(field('PIB')).toHaveValue('100002887');
    expect(field('Matični broj (MB)')).toHaveValue('07036540');
    expect(field('Obveznik PDV-a')).toBeChecked();
    expect(field('Kategorija smeštaja')).toHaveValue('hotel');
    expect(field('Broj rešenja o kategorizaciji')).toHaveValue('12/2026');
    expect(field('Način fiskalizacije')).toHaveValue('required');
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(/Za račune nedostaje/)).toBeNull();
  });

  it('lists what the invoices still lack, named for the kind', async () => {
    setup({ ...COMPANY, address: null, city: null, registryId: null, missing: ['address', 'city', 'registryId'], complete: false });
    await open();
    expect(screen.getByText('Za račune nedostaje: adresa, mesto, matični broj.')).toBeInTheDocument();
  });

  it('for a natural person the missing registry id is a JMBG', async () => {
    setup({ ...PERSON, legalName: null, missing: ['legalName', 'registryId'], complete: false });
    await open();
    expect(screen.getByText('Za račune nedostaje: pun naziv, JMBG.')).toBeInTheDocument();
  });

  it('shows no fiscal notice when the API sends none', async () => {
    setup(PERSON);
    await open();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('a profile that was never saved offers the three kinds and none is chosen', async () => {
    setup(EMPTY);
    await open();
    expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['legal_entity', 'entrepreneur', 'natural_person']);
    expect(screen.getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);
    expect(screen.getByText('Za račune nedostaje: pun naziv, adresa, mesto, PIB, matični broj.')).toBeInTheDocument();
    expect(field('Način fiskalizacije')).toHaveValue('');
  });

  it('a receptionist gets a sentence instead of the form', async () => {
    setup(COMPANY, {}, { role: 'receptionist' });
    render(<LegalProfilePage />);
    expect(await screen.findByText('Pravni profil menjaju vlasnik i menadžer.')).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('in safe mode the form is there but every control is off', async () => {
    setup(COMPANY, {}, { state: 'EXPIRED' });
    await open();
    await vi.waitFor(() => expect(save()).toBeDisabled());
    expect(field('PIB')).toBeDisabled();
    expect(screen.getByText('Licenca ne dozvoljava izmene. Pravni profil je samo za pregled.')).toBeInTheDocument();
  });

  it('in safe mode a submit that gets past the disabled controls still sends nothing', async () => {
    const calls = setup(COMPANY, {}, { state: 'EXPIRED' });
    await open();
    await vi.waitFor(() => expect(save()).toBeDisabled());
    fireEvent.submit(screen.getByRole('form', { name: 'Pravni profil objekta' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(puts(calls)).toHaveLength(0);
  });

  it('shows a failed read', async () => {
    setup(COMPANY, { 'GET /api/legal-profile': apiError(500, 'unknown') });
    render(<LegalProfilePage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Došlo je do greške.');
  });
});

describe('Pravni profil: the kind decides the required fields', () => {
  it('pravno lice sa PIB 100002888 prikazuje grešku kontrolne cifre bez slanja', async () => {
    const calls = setup(COMPANY);
    const user = userEvent.setup();
    await open();
    await fill(user, 'PIB', '100002888');
    await user.click(save());

    const pib = field('PIB');
    expect(pib).toHaveAttribute('aria-invalid', 'true');
    expect(pib).toHaveFocus();
    const message = screen.getByText('PIB nije ispravan: kontrolna cifra se ne slaže.');
    expect(message).toHaveAttribute('id', 'taxId-error');
    expect(pib.getAttribute('aria-describedby')).toContain('taxId-error');
    expect(puts(calls)).toHaveLength(0);
  });

  it('typing in a field takes its error away', async () => {
    setup(COMPANY);
    const user = userEvent.setup();
    await open();
    await fill(user, 'PIB', '100002888');
    await user.click(save());
    expect(field('PIB')).toHaveAttribute('aria-invalid', 'true');
    await fill(user, 'PIB', '100002887');
    expect(field('PIB')).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText('PIB nije ispravan: kontrolna cifra se ne slaže.')).toBeNull();
  });

  it('a PIB of eight digits is refused with the length message', async () => {
    const calls = setup(COMPANY);
    const user = userEvent.setup();
    await open();
    await fill(user, 'PIB', '10000288');
    await user.click(save());
    expect(screen.getByText('PIB nije ispravan: mora imati tačno 9 cifara.')).toBeInTheDocument();
    expect(puts(calls)).toHaveLength(0);
  });

  it('an entrepreneur or company without PIB and MB is led to fill them, and nothing is sent', async () => {
    const calls = setup({ ...COMPANY, taxId: null, registryId: null, missing: ['taxId', 'registryId'], complete: false });
    const user = userEvent.setup();
    await open();
    expect(screen.getByText('Prvo upišite PIB i matični broj; bez njih se profil ne čuva.')).toBeInTheDocument();
    await user.selectOptions(field('Način fiskalizacije'), 'invoice_only');
    await user.click(save());
    expect(screen.getByText('PIB je obavezan.')).toBeInTheDocument();
    expect(screen.getByText('Matični broj je obavezan.')).toBeInTheDocument();
    expect(field('PIB')).toHaveFocus();
    expect(puts(calls)).toHaveLength(0);
  });

  it('the hint about the ids goes away once both are filled', async () => {
    setup({ ...COMPANY, taxId: null, registryId: null, missing: ['taxId', 'registryId'], complete: false });
    const user = userEvent.setup();
    await open();
    await fill(user, 'PIB', '100002887');
    expect(screen.getByText('Prvo upišite PIB i matični broj; bez njih se profil ne čuva.')).toBeInTheDocument();
    await fill(user, 'Matični broj (MB)', '07036540');
    expect(screen.queryByText('Prvo upišite PIB i matični broj; bez njih se profil ne čuva.')).toBeNull();
  });

  it('an MB of seven digits is refused', async () => {
    const calls = setup(COMPANY);
    const user = userEvent.setup();
    await open();
    await fill(user, 'Matični broj (MB)', '7036540');
    await user.click(save());
    expect(screen.getByText('Matični broj nije ispravan: mora imati tačno 8 cifara.')).toBeInTheDocument();
    expect(field('Matični broj (MB)')).toHaveFocus();
    expect(puts(calls)).toHaveLength(0);
  });

  it('a natural person needs no PIB and no JMBG', async () => {
    const calls = setup({ ...PERSON, registryId: null }, { 'PUT /api/legal-profile': { body: PERSON } });
    const user = userEvent.setup();
    await open();
    expect(field('JMBG')).toHaveValue('');
    await user.click(save());
    await screen.findByText('Pravni profil je sačuvan.');
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0].body).toMatchObject({ taxId: null, registryId: null });
  });
});

describe('Pravni profil: the masked JMBG', () => {
  it('fizičko lice: polje JMBG prikazuje maskiranu vrednost i ne šalje je kao novu', async () => {
    const calls = setup(PERSON, { 'PUT /api/legal-profile': { body: PERSON } });
    const user = userEvent.setup();
    await open();
    expect(field('JMBG')).toHaveValue('•••••••••0008');
    expect(screen.getByText('Prikazan je maskiran. Upišite novi JMBG da biste ga zamenili.')).toBeInTheDocument();
    await fill(user, 'Telefon', '064 111 222');
    await user.click(save());
    await screen.findByText('Pravni profil je sačuvan.');
    const body = puts(calls)[0].body as Record<string, unknown>;
    expect('registryId' in body).toBe(false);
    expect(body.phone).toBe('064 111 222');
    // The answer is masked again.
    expect(field('JMBG')).toHaveValue('•••••••••0008');
  });

  it('a new valid JMBG is sent', async () => {
    const calls = setup(PERSON, { 'PUT /api/legal-profile': { body: PERSON } });
    const user = userEvent.setup();
    await open();
    await fill(user, 'JMBG', '0101990710008');
    await user.click(save());
    await screen.findByText('Pravni profil je sačuvan.');
    expect((puts(calls)[0].body as Record<string, unknown>).registryId).toBe('0101990710008');
  });

  it('clearing the JMBG sends null', async () => {
    const calls = setup(PERSON, { 'PUT /api/legal-profile': { body: { ...PERSON, registryId: null } } });
    const user = userEvent.setup();
    await open();
    await fill(user, 'JMBG', '');
    await user.click(save());
    await screen.findByText('Pravni profil je sačuvan.');
    expect((puts(calls)[0].body as Record<string, unknown>).registryId).toBeNull();
  });

  it.each([
    ['0101990710007', 'JMBG nije ispravan: kontrolna cifra se ne slaže.'],
    ['3102990710005', 'JMBG nije ispravan: datum rođenja ne postoji.'],
    ['010199071000', 'JMBG nije ispravan: mora imati tačno 13 cifara.'],
    ['•••••••••000', 'Upišite ceo JMBG (13 cifara) ili ostavite polje kako je.'],
  ])('the JMBG %s is refused without sending', async (jmbg, message) => {
    const calls = setup(PERSON);
    const user = userEvent.setup();
    await open();
    await fill(user, 'JMBG', jmbg);
    await user.click(save());
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(field('JMBG')).toHaveAttribute('aria-invalid', 'true');
    expect(field('JMBG')).toHaveFocus();
    expect(puts(calls)).toHaveLength(0);
  });
});

describe('Pravni profil: the first save', () => {
  it('without a chosen kind nothing is sent and the radios take the focus', async () => {
    const calls = setup(EMPTY);
    const user = userEvent.setup();
    await open();
    await user.click(save());
    expect(screen.getByText('Izaberite vrstu lica.')).toHaveAttribute('id', 'kind-error');
    expect(screen.getAllByRole('radio')[0]).toHaveFocus();
    expect(puts(calls)).toHaveLength(0);
  });

  it('sends the chosen kind with the whole form, and no fiscal mode until one is chosen', async () => {
    const calls = setup(EMPTY, { 'PUT /api/legal-profile': { body: COMPANY } });
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('radio', { name: 'Preduzetnik' }));
    await fill(user, 'Pun naziv', '  Ana Anić PR  ');
    await fill(user, 'PIB', '100002887');
    await fill(user, 'Matični broj (MB)', '07036540');
    await user.click(save());
    await screen.findByText('Pravni profil je sačuvan.');
    expect(puts(calls)[0].body).toEqual({
      kind: 'entrepreneur',
      legalName: 'Ana Anić PR',
      taxId: '100002887',
      registryId: '07036540',
      vatPayer: false,
      address: null,
      postalCode: null,
      city: null,
      activityCode: null,
      bankAccount: null,
      email: null,
      phone: null,
      accommodationCategory: null,
      categorizationNumber: null,
    });
    // The saved profile replaces the form: the kind is fixed now.
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('choosing the kind natural person drops the PIB requirement', async () => {
    const calls = setup(EMPTY, { 'PUT /api/legal-profile': { body: PERSON } });
    const user = userEvent.setup();
    await open();
    expect(field('PIB')).toHaveAttribute('aria-required', 'true');
    await user.click(screen.getByRole('radio', { name: 'Fizičko lice' }));
    expect(field('PIB')).not.toHaveAttribute('aria-required');
    expect(screen.getByLabelText('JMBG')).toBeInTheDocument();
    await user.click(save());
    await screen.findByText('Pravni profil je sačuvan.');
    expect((puts(calls)[0].body as Record<string, unknown>).kind).toBe('natural_person');
  });
});

describe('Pravni profil: saving', () => {
  it('sends the whole form on a saved profile, without the kind', async () => {
    const calls = setup(COMPANY, { 'PUT /api/legal-profile': { body: { ...COMPANY, fiscalComplianceMode: 'invoice_only', fiscalNotice: null } } });
    const user = userEvent.setup();
    await open();
    await user.selectOptions(field('Način fiskalizacije'), 'invoice_only');
    await user.selectOptions(field('Kategorija smeštaja'), 'apartment');
    await user.click(field('Obveznik PDV-a'));
    await user.click(save());
    await screen.findByText('Pravni profil je sačuvan.');
    expect(puts(calls)[0].body).toEqual({
      legalName: 'Hotel Demo d.o.o.',
      taxId: '100002887',
      registryId: '07036540',
      vatPayer: false,
      address: 'Knez Mihailova 1',
      postalCode: '11000',
      city: 'Beograd',
      activityCode: '5510',
      bankAccount: '160-0000000123456-78',
      email: 'racun@demo.rs',
      phone: '+381 11 123 456',
      accommodationCategory: 'apartment',
      categorizationNumber: '12/2026',
      fiscalComplianceMode: 'invoice_only',
    });
    // The notice follows the saved profile.
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('a cleared optional field is sent as null, the category too', async () => {
    const calls = setup(COMPANY, { 'PUT /api/legal-profile': { body: COMPANY } });
    const user = userEvent.setup();
    await open();
    await fill(user, 'Telefon', '   ');
    await user.selectOptions(field('Kategorija smeštaja'), '');
    await user.click(save());
    await screen.findByText('Pravni profil je sačuvan.');
    expect(puts(calls)[0].body).toMatchObject({ phone: null, accommodationCategory: null, vatPayer: true });
  });

  it('shows the missing list of the saved answer', async () => {
    setup(COMPANY, { 'PUT /api/legal-profile': { body: { ...COMPANY, address: null, missing: ['address'], complete: false } } });
    const user = userEvent.setup();
    await open();
    await fill(user, 'Adresa', '');
    await user.click(save());
    expect(await screen.findByText('Za račune nedostaje: adresa.')).toBeInTheDocument();
  });

  it('marks the field the API refused', async () => {
    setup(COMPANY, { 'PUT /api/legal-profile': apiError(422, 'validation_failed', 'x', { field: 'bankAccount' }) });
    const user = userEvent.setup();
    await open();
    await user.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent('Proverite polje „Broj računa“.');
    expect(field('Broj računa')).toHaveAttribute('aria-invalid', 'true');
    expect(field('Broj računa')).toHaveFocus();
  });

  it('shows another refusal at the top and keeps what was typed', async () => {
    setup(COMPANY, { 'PUT /api/legal-profile': apiError(403, 'safe_mode_blocked') });
    const user = userEvent.setup();
    await open();
    await fill(user, 'Mesto', 'Novi Sad');
    await user.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent('Licenca je istekla.');
    expect(field('Mesto')).toHaveValue('Novi Sad');
  });

  it('a double click saves once, and the button is off while it runs', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = setup(COMPANY, {
      'PUT /api/legal-profile': async () => {
        await gate;
        return { body: COMPANY };
      },
    });
    const user = userEvent.setup();
    await open();
    await user.dblClick(save());
    expect(save()).toBeDisabled();
    release();
    await screen.findByText('Pravni profil je sačuvan.');
    expect(puts(calls)).toHaveLength(1);
  });

  it('two clicks in the same tick (before the button is disabled) still save once', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = setup(COMPANY, {
      'PUT /api/legal-profile': async () => {
        await gate;
        return { body: COMPANY };
      },
    });
    await open();
    const button = save();
    act(() => {
      button.click();
      button.click();
    });
    release();
    await screen.findByText('Pravni profil je sačuvan.');
    expect(puts(calls)).toHaveLength(1);
  });
});
