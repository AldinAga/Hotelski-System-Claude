import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockFetch } from '@/test/fetch-mock';
import { api, ApiError, checkSetup, navigation } from './api';
import { MESSAGES, messageFor } from './messages';

const go = () => navigation.go;

beforeEach(() => {
  vi.spyOn(navigation, 'go').mockImplementation(() => undefined);
  window.history.replaceState(null, '', '/podesavanja/jedinice');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('api', () => {
  it('calls the API through the same-origin /api prefix and sends JSON', async () => {
    const calls = mockFetch({ 'POST /api/unit-types': { status: 201, body: { id: 't1' } } });
    const out = await api<{ id: string }>('/unit-types', { method: 'POST', body: JSON.stringify({ code: 'DBL' }) });
    expect(out).toEqual({ id: 't1' });
    expect(calls).toEqual([{ method: 'POST', url: '/api/unit-types', body: { code: 'DBL' } }]);
  });

  it('401 vodi na /prijava', async () => {
    mockFetch({ 'GET /api/units': apiError(401, 'session_required') });
    const err = await api('/units').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: 'session_required' });
    expect(go()).toHaveBeenCalledWith('/prijava');
  });

  it('a 401 from the sign-in call itself stays on the page (totp_required is an answer, not a lost session)', async () => {
    window.history.replaceState(null, '', '/');
    mockFetch({ 'POST /api/auth/login': apiError(401, 'totp_required') });
    const err = await api('/auth/login', { method: 'POST', body: '{}' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, code: 'totp_required' });
    expect(go()).not.toHaveBeenCalled();
  });

  it('a non-401 error does not navigate', async () => {
    mockFetch({ 'GET /api/units': apiError(403, 'safe_mode_blocked') });
    await expect(api('/units')).rejects.toMatchObject({ status: 403, code: 'safe_mode_blocked' });
    expect(go()).not.toHaveBeenCalled();
  });

  it('GET /setup/status with activated: false leads to /aktivacija', async () => {
    mockFetch({ 'GET /api/setup/status': { body: { activated: false, hasOwner: false, hasProperty: false } } });
    await api('/setup/status');
    expect(go()).toHaveBeenCalledWith('/aktivacija');
  });

  it('GET /setup/status with hasOwner: false leads to /aktivacija', async () => {
    mockFetch({ 'GET /api/setup/status': { body: { activated: true, hasOwner: false, hasProperty: false } } });
    await api('/setup/status');
    expect(go()).toHaveBeenCalledWith('/aktivacija');
  });

  it('410 on /setup/status means set up: checkSetup says done and nothing navigates', async () => {
    mockFetch({ 'GET /api/setup/status': apiError(410, 'setup_done') });
    expect(await checkSetup()).toBe('done');
    expect(go()).not.toHaveBeenCalled();
  });

  it('turns a failed network call into network_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(api('/units')).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });
});

describe('messageFor', () => {
  it('uses the dictionary text, not the server message, and fills in details', () => {
    const err = new ApiError(409, 'no_availability', 'server text', { day: '2026-12-24' });
    expect(messageFor(err)).toBe('Nema slobodnih jedinica za 24.12.2026.');
  });

  it('has the safe-mode text', () => {
    expect(MESSAGES.safe_mode_blocked).toBe(
      'Licenca je istekla. Sistem radi u sigurnom režimu: pregled je dozvoljen, izmene nisu.',
    );
  });

  it('falls back to the server message for an unknown code', () => {
    expect(messageFor(new ApiError(500, 'something_new', 'Serverska poruka.', null))).toBe('Serverska poruka.');
  });

  it('unit_has_stays points to where a stay can be moved, and says an untyped one cannot be', () => {
    const text = MESSAGES.unit_has_stays;
    expect(text).toMatch(/stranici rezervacije/);
    expect(text).toMatch(/bez tipa/);
    expect(text).toMatch(/otkaž/);
    expect(text).not.toMatch(/Prvo ga premestite na drugu jedinicu, pa ponovo/);
  });

  it('covers the refusals of the request guard (src/http.ts in hotel-api)', () => {
    const http = readFileSync(resolve(__dirname, '../../../hotel-api/src/http.ts'), 'utf8');
    const codes = [...http.matchAll(/refuse\(\s*res,\s*\d+,\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(codes.sort()).toEqual(['origin_refused', 'unsupported_media_type']);
    for (const code of codes) expect(MESSAGES[code], code).toBeTruthy();
  });

  it('covers every refusal of a unit change', () => {
    for (const code of ['unit_has_blocks', 'unit_has_stays', 'inventory_conflict', 'scope_not_priced', 'setup_token_invalid']) {
      expect(MESSAGES[code], code).toBeTruthy();
    }
  });

  it('covers every code the reservation screens can receive, read from the API source', () => {
    const api = resolve(__dirname, '../../../hotel-api/src');
    const codes = new Set<string>();
    for (const file of [
      'reservations/reservations.service.ts',
      'reservations/stay-dates.ts',
      'inventory/inventory.service.ts',
      'rates/rates.service.ts',
      'rates/quote.ts',
      'common/input.ts',
      // The night audit: the close dialog and the closed-day screens (Task 12).
      'business-day/night-audit.service.ts',
      // Check-in, check-out and the guests of a stay (Task 10).
      'stays/stay-lifecycle.service.ts',
      'guests/guests.service.ts',
    ]) {
      const text = readFileSync(resolve(api, file), 'utf8');
      for (const m of text.matchAll(/DomainError\(\s*'([a-z_]+)'/g)) codes.add(m[1]);
      // Reasons returned as values and thrown by the caller (stay dates, quote).
      for (const m of text.matchAll(/reason: '([a-z_]+)'/g)) codes.add(m[1]);
    }
    // A floor, so a broken pattern cannot pass with nothing found.
    expect(codes.size).toBeGreaterThanOrEqual(20);
    expect([...codes].filter((c) => !MESSAGES[c])).toEqual([]);
  });

  it('a stay field in validation_failed is named as the form names it', () => {
    expect(messageFor(new ApiError(422, 'validation_failed', 'x', { field: 'stays[0].adults' }))).toBe('Proverite polje „Odrasli“.');
    expect(messageFor(new ApiError(422, 'validation_failed', 'x', { field: 'holder.firstName' }))).toBe('Proverite polje „Ime“.');
  });

  it('check_in_wrong_day names both days; once the arrival is behind the open day it does not tell to close it', () => {
    const ahead = new ApiError(409, 'check_in_wrong_day', 'x', { arrival: '2026-11-13', businessDate: '2026-11-12' });
    expect(messageFor(ahead)).toBe(
      'Dolazak je 13.11.2026, a poslovni dan je 12.11.2026. Zatvorite poslovni dan pre prijave gosta.',
    );
    const behind = new ApiError(409, 'check_in_wrong_day', 'x', { arrival: '2026-11-11', businessDate: '2026-11-12' });
    expect(messageFor(behind)).toBe(
      'Dolazak je bio 11.11.2026, a poslovni dan je 12.11.2026. Prijava na dan dolaska više nije moguća.',
    );
  });

  it('folio_balance_open shows the amount in dinars', () => {
    expect(messageFor(new ApiError(409, 'folio_balance_open', 'x', { balanceMinor: 500000 }))).toBe(
      'Saldo folija nije nula (5.000,00 RSD). Naplatite ili vratite razliku pre odjave.',
    );
  });

  it('the dictionary has no Cyrillic letters', () => {
    expect(Object.values(MESSAGES).filter((t) => /[\u0400-\u04FF]/.test(t))).toEqual([]);
  });

  it('no_availability names the night as D.M.YYYY', () => {
    expect(messageFor(new ApiError(409, 'no_availability', 'x', { day: '2026-12-02' }))).toBe('Nema slobodnih jedinica za 2.12.2026.');
  });
});
