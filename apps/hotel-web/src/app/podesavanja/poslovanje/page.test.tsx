import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navigation } from '@/lib/api';
import type { BusinessSettings } from '@/lib/business';
import { apiError, mockFetch, type Call } from '@/test/fetch-mock';
import BusinessSettingsPage from './page';

const SETTINGS: BusinessSettings = { autoCloseTime: '03:00', noShowCharge: 'first_night', accommodationVatBp: 1000, vatRatesBp: [2000, 1000] };

type Route = Parameters<typeof mockFetch>[0][string];

function setup(extra: Record<string, Route> = {}, over: { state?: string; role?: string; settings?: BusinessSettings | Route } = {}) {
  const settings = over.settings ?? SETTINGS;
  return mockFetch({
    'GET /api/licence': { body: { activated: true, modules: ['hotel.core', 'hotel.folio'], limits: {}, state: over.state ?? 'VALID' } },
    'GET /api/auth/me': { body: { role: over.role ?? 'owner' } },
    'GET /api/settings/business': typeof settings === 'function' || 'status' in settings || 'body' in settings ? (settings as Route) : { body: settings },
    ...extra,
  });
}

const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT');
const field = (name: string) => screen.getByLabelText(name);

async function open() {
  render(<BusinessSettingsPage />);
  await screen.findByRole('form', { name: 'Podešavanja poslovanja' });
}

beforeEach(() => {
  vi.spyOn(navigation, 'go').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Poslovanje: showing the settings', () => {
  it('fills the form from the stored settings, rates as percentages', async () => {
    setup();
    await open();
    expect(field('Vreme automatskog zatvaranja')).toHaveValue('03:00');
    expect(field('Kad gost ne dođe')).toHaveValue('first_night');
    expect(field('PDV stopa smeštaja (%)')).toHaveValue('10');
    const rates = screen.getByRole('list', { name: 'Dozvoljene stope za zaduženja (%)' });
    expect(within(rates).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['20 %×', '10 %×']);
  });

  it('empty settings: manual close, no charge, no rates', async () => {
    setup({}, { settings: { autoCloseTime: null, noShowCharge: 'none', accommodationVatBp: null, vatRatesBp: [] } });
    await open();
    expect(field('Vreme automatskog zatvaranja')).toHaveValue('');
    expect(field('Kad gost ne dođe')).toHaveValue('none');
    expect(field('PDV stopa smeštaja (%)')).toHaveValue('');
    expect(screen.getByText('Nijedna stopa nije dodata.')).toBeInTheDocument();
  });

  it('a receptionist gets a sentence instead of the form', async () => {
    setup({}, { role: 'receptionist' });
    render(<BusinessSettingsPage />);
    expect(await screen.findByText('Podešavanja poslovanja menjaju vlasnik i menadžer.')).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('in safe mode the form is there but every control is off', async () => {
    setup({}, { state: 'EXPIRED' });
    await open();
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Sačuvaj' })).toBeDisabled());
    expect(field('Vreme automatskog zatvaranja')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Dodaj stopu' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ukloni stopu 20 %' })).toBeDisabled();
    expect(screen.getByText('Licenca ne dozvoljava izmene. Podešavanja su samo za pregled.')).toBeInTheDocument();
  });

  it('in safe mode a submit that gets past the disabled controls still sends nothing', async () => {
    const calls = setup({}, { state: 'EXPIRED' });
    await open();
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Sačuvaj' })).toBeDisabled());
    fireEvent.submit(screen.getByRole('form', { name: 'Podešavanja poslovanja' }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(puts(calls)).toHaveLength(0);
  });

  it('shows a failed read', async () => {
    setup({}, { settings: apiError(500, 'unknown') });
    render(<BusinessSettingsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Došlo je do greške. Pokušajte ponovo.');
  });
});

describe('Poslovanje: saving', () => {
  it('sends the percentages as basis points and everything else as chosen', async () => {
    const calls = setup({ 'PUT /api/settings/business': { body: { autoCloseTime: '23:59', noShowCharge: 'none', accommodationVatBp: 1050, vatRatesBp: [2000, 1000, 2025] } } });
    const user = userEvent.setup();
    await open();

    await user.clear(field('Vreme automatskog zatvaranja'));
    await user.type(field('Vreme automatskog zatvaranja'), '23:59');
    await user.selectOptions(field('Kad gost ne dođe'), 'none');
    await user.clear(field('PDV stopa smeštaja (%)'));
    await user.type(field('PDV stopa smeštaja (%)'), '10,5');
    await user.type(field('Nova stopa (%)'), '20.25');
    await user.click(screen.getByRole('button', { name: 'Dodaj stopu' }));
    expect(field('Nova stopa (%)')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Sačuvaj' }));

    expect(await screen.findByText('Podešavanja su sačuvana.')).toBeInTheDocument();
    expect(puts(calls)).toEqual([
      {
        method: 'PUT',
        url: '/api/settings/business',
        body: { autoCloseTime: '23:59', noShowCharge: 'none', accommodationVatBp: 1050, vatRatesBp: [2000, 1000, 2025] },
      },
    ]);
    // The form shows what the server answered.
    expect(field('PDV stopa smeštaja (%)')).toHaveValue('10,5');
  });

  it('an empty time is sent as null (manual close), an empty VAT as null', async () => {
    const calls = setup({ 'PUT /api/settings/business': { body: { autoCloseTime: null, noShowCharge: 'first_night', accommodationVatBp: null, vatRatesBp: [2000, 1000] } } });
    const user = userEvent.setup();
    await open();
    await user.clear(field('Vreme automatskog zatvaranja'));
    await user.clear(field('PDV stopa smeštaja (%)'));
    await user.click(screen.getByRole('button', { name: 'Sačuvaj' }));
    await screen.findByText('Podešavanja su sačuvana.');
    expect(puts(calls)[0].body).toEqual({ autoCloseTime: null, noShowCharge: 'first_night', accommodationVatBp: null, vatRatesBp: [2000, 1000] });
  });

  it('vreme 24:00 se ne šalje', async () => {
    const calls = setup();
    const user = userEvent.setup();
    await open();
    await user.clear(field('Vreme automatskog zatvaranja'));
    await user.type(field('Vreme automatskog zatvaranja'), '24:00');
    await user.click(screen.getByRole('button', { name: 'Sačuvaj' }));

    const input = field('Vreme automatskog zatvaranja');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveFocus();
    const message = 'Upišite vreme od 00:00 do 23:59, na primer 03:00. Za ručno zatvaranje ostavite polje prazno.';
    expect(screen.getByText(message)).toHaveAttribute('id', 'autoCloseTime-error');
    expect(input.getAttribute('aria-describedby')).toContain('autoCloseTime-error');
    expect(puts(calls)).toHaveLength(0);
  });

  it.each(['3:00', '12:60', 'abc', '03:0'])('the time %s is refused without sending', async (time) => {
    const calls = setup();
    const user = userEvent.setup();
    await open();
    await user.clear(field('Vreme automatskog zatvaranja'));
    await user.type(field('Vreme automatskog zatvaranja'), time);
    await user.click(screen.getByRole('button', { name: 'Sačuvaj' }));
    expect(field('Vreme automatskog zatvaranja')).toHaveAttribute('aria-invalid', 'true');
    expect(puts(calls)).toHaveLength(0);
  });

  it.each(['abc', '101', '10,555', '-5'])('the VAT rate %s is refused without sending', async (rate) => {
    const calls = setup();
    const user = userEvent.setup();
    await open();
    await user.clear(field('PDV stopa smeštaja (%)'));
    await user.type(field('PDV stopa smeštaja (%)'), rate);
    await user.click(screen.getByRole('button', { name: 'Sačuvaj' }));
    expect(field('PDV stopa smeštaja (%)')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Upišite stopu od 0 do 100 %, na primer 10 ili 10,5.')).toBeInTheDocument();
    expect(puts(calls)).toHaveLength(0);
  });

  it('a rate typed but not added is not lost silently', async () => {
    const calls = setup();
    const user = userEvent.setup();
    await open();
    await user.type(field('Nova stopa (%)'), '5');
    await user.click(screen.getByRole('button', { name: 'Sačuvaj' }));
    expect(screen.getByText('Dodajte stopu dugmetom „Dodaj stopu“ ili obrišite polje.')).toBeInTheDocument();
    expect(field('Nova stopa (%)')).toHaveFocus();
    expect(puts(calls)).toHaveLength(0);
  });

  it('the first field with an error takes the focus', async () => {
    setup();
    const user = userEvent.setup();
    await open();
    await user.clear(field('PDV stopa smeštaja (%)'));
    await user.type(field('PDV stopa smeštaja (%)'), 'x');
    await user.type(field('Nova stopa (%)'), '5');
    await user.click(screen.getByRole('button', { name: 'Sačuvaj' }));
    expect(field('PDV stopa smeštaja (%)')).toHaveFocus();
  });

  it('shows the API refusing a field and marks that field', async () => {
    setup({ 'PUT /api/settings/business': apiError(422, 'validation_failed', 'x', { field: 'autoCloseTime' }) });
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'Sačuvaj' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Proverite polje „Vreme automatskog zatvaranja“.');
    expect(field('Vreme automatskog zatvaranja')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows another refusal at the top and keeps the typed values', async () => {
    setup({ 'PUT /api/settings/business': apiError(403, 'safe_mode_blocked') });
    const user = userEvent.setup();
    await open();
    await user.clear(field('PDV stopa smeštaja (%)'));
    await user.type(field('PDV stopa smeštaja (%)'), '8');
    await user.click(screen.getByRole('button', { name: 'Sačuvaj' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Licenca je istekla.');
    expect(field('PDV stopa smeštaja (%)')).toHaveValue('8');
  });

  it('a double click saves once, and the button is off while it runs', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = setup({
      'PUT /api/settings/business': async () => {
        await gate;
        return { body: SETTINGS };
      },
    });
    const user = userEvent.setup();
    await open();
    await user.dblClick(screen.getByRole('button', { name: 'Sačuvaj' }));
    expect(screen.getByRole('button', { name: 'Sačuvaj' })).toBeDisabled();
    release();
    await screen.findByText('Podešavanja su sačuvana.');
    expect(puts(calls)).toHaveLength(1);
  });

  it('two clicks in the same tick (before the button is disabled) still save once', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = setup({
      'PUT /api/settings/business': async () => {
        await gate;
        return { body: SETTINGS };
      },
    });
    await open();
    const save = screen.getByRole('button', { name: 'Sačuvaj' });
    act(() => {
      save.click();
      save.click();
    });
    release();
    await screen.findByText('Podešavanja su sačuvana.');
    expect(puts(calls)).toHaveLength(1);
  });
});

describe('Poslovanje: the list of rates', () => {
  it('removes a rate with its own button', async () => {
    const calls = setup({ 'PUT /api/settings/business': { body: { ...SETTINGS, vatRatesBp: [1000] } } });
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'Ukloni stopu 20 %' }));
    expect(screen.queryByRole('button', { name: 'Ukloni stopu 20 %' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sačuvaj' }));
    await screen.findByText('Podešavanja su sačuvana.');
    expect((puts(calls)[0].body as BusinessSettings).vatRatesBp).toEqual([1000]);
  });

  it.each([
    ['abc', 'Upišite stopu od 0 do 100 %, na primer 20 ili 10,5.'],
    ['101', 'Upišite stopu od 0 do 100 %, na primer 20 ili 10,5.'],
    ['20', 'Ta stopa je već na spisku.'],
    ['20,00', 'Ta stopa je već na spisku.'],
  ])('the rate %s is not added: %s', async (text, message) => {
    setup();
    const user = userEvent.setup();
    await open();
    await user.type(field('Nova stopa (%)'), text);
    await user.click(screen.getByRole('button', { name: 'Dodaj stopu' }));
    expect(screen.getByText(message)).toHaveAttribute('id', 'newRate-error');
    expect(field('Nova stopa (%)')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getAllByRole('button', { name: /^Ukloni stopu/ })).toHaveLength(2);
  });

  it('at most five rates', async () => {
    setup({}, { settings: { ...SETTINGS, vatRatesBp: [100, 200, 300, 400, 500] } });
    const user = userEvent.setup();
    await open();
    await user.type(field('Nova stopa (%)'), '6');
    await user.click(screen.getByRole('button', { name: 'Dodaj stopu' }));
    expect(screen.getByText('Na spisku može biti najviše 5 stopa.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Ukloni stopu/ })).toHaveLength(5);
  });

  it('typing again clears the error of the rate field', async () => {
    setup();
    const user = userEvent.setup();
    await open();
    await user.type(field('Nova stopa (%)'), 'x');
    await user.click(screen.getByRole('button', { name: 'Dodaj stopu' }));
    expect(field('Nova stopa (%)')).toHaveAttribute('aria-invalid', 'true');
    await user.type(field('Nova stopa (%)'), '1');
    await waitFor(() => expect(field('Nova stopa (%)')).not.toHaveAttribute('aria-invalid'));
  });
});
