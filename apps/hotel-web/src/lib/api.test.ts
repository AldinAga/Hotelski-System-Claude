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

  it('covers every refusal of a unit change', () => {
    for (const code of ['unit_has_blocks', 'unit_has_stays', 'inventory_conflict', 'scope_not_priced', 'setup_token_invalid']) {
      expect(MESSAGES[code], code).toBeTruthy();
    }
  });
});
