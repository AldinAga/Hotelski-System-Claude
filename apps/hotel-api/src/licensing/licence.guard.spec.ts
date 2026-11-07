import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import type { LicenseEvaluation, LicensePayload } from '@platform/licensing';
import { DomainError } from '../common/domain-error';
import { LicenceGuard } from './licence.guard';
import type { LicenceService } from './licence.service';
import { LicensedAction, Unlicensed } from './licensed-action';
import { SAFE_MODE_ALLOWED } from './safe-mode';

// Routes as a controller would declare them.
class Reservations {
  @LicensedAction('hotel.core', 'reservation.view')
  view(): void {}

  @LicensedAction('hotel.core', 'reservation.create')
  create(): void {}

  // A safe action of a module the licence does not include.
  @LicensedAction('hotel.channel', 'reservation.view')
  channelView(): void {}

  @Unlicensed()
  open(): void {}

  unannotated(): void {}
}

@Unlicensed()
class OpenByClass {
  inherits(): void {}

  @LicensedAction('hotel.core', 'reservation.create')
  overridden(): void {}
}

function payload(over: Partial<LicensePayload> = {}): LicensePayload {
  return {
    type: 'license',
    license_id: 'lic-1',
    revision: 1,
    client_id: 'c',
    product: 'hotel',
    installation_id: 'i',
    subscription_status: 'active',
    modules: ['hotel.core'],
    limits: {},
    issued_at: '2026-01-01T00:00:00.000Z',
    valid_until: '2026-02-01T00:00:00.000Z',
    grace_until: '2026-02-08T00:00:00.000Z',
    expiry_mode: 'safe_mode',
    claims: {},
    ...over,
  };
}

const memory = { highestRevision: 1, maxIssuedAt: null, lastServerTime: null };

const STATES: Record<string, LicenseEvaluation | null> = {
  VALID: { state: 'VALID', payload: payload(), memory },
  GRACE: { state: 'GRACE', payload: payload(), memory },
  'EXPIRED safe_mode': { state: 'EXPIRED', payload: payload({ expiry_mode: 'safe_mode' }), memory },
  'EXPIRED hard_lock': { state: 'EXPIRED', payload: payload({ expiry_mode: 'hard_lock' }), memory },
  INVALID: { state: 'INVALID', reason: 'bad_signature' },
  'not activated': null,
};

function guardFor(evaluation: LicenseEvaluation | null): LicenceGuard {
  const licence = { evaluation: () => evaluation } as unknown as LicenceService;
  return new LicenceGuard(new Reflector(), licence);
}

/** 'allow' or the 403 code the guard answered with. */
function decide(evaluation: LicenseEvaluation | null, cls: new () => object, method: string): string {
  const handler = (cls.prototype as Record<string, () => void>)[method];
  const ctx = new ExecutionContextHost([{}, {}], cls as never, handler);
  ctx.setType('http');
  try {
    return guardFor(evaluation).canActivate(ctx) === true ? 'allow' : 'returned false';
  } catch (err) {
    if (err instanceof DomainError && err.status === 403) return err.code;
    throw err;
  }
}

describe('LicenceGuard', () => {
  // SPEC section 7, first hit wins. Columns: reservation.view (in the safe
  // set), reservation.create (not in it), reservation.view of a module the
  // licence does not include.
  const table: Array<[string, string, string, string]> = [
    ['VALID', 'allow', 'allow', 'module_not_licensed'],
    ['GRACE', 'allow', 'allow', 'module_not_licensed'],
    ['EXPIRED safe_mode', 'allow', 'safe_mode_blocked', 'module_not_licensed'],
    ['EXPIRED hard_lock', 'expired_hard_lock', 'expired_hard_lock', 'module_not_licensed'],
    ['INVALID', 'invalid_license', 'invalid_license', 'invalid_license'],
    ['not activated', 'not_activated', 'not_activated', 'not_activated'],
  ];

  it.each(table)('%s: view %s, create %s, unlicensed module %s', (state, view, create, channel) => {
    const evaluation = STATES[state];
    expect(decide(evaluation, Reservations, 'view')).toBe(view);
    expect(decide(evaluation, Reservations, 'create')).toBe(create);
    expect(decide(evaluation, Reservations, 'channelView')).toBe(channel);
  });

  it('EXPIRED + safe_mode: reservation.view allowed, reservation.create 403 safe_mode_blocked', () => {
    const expired = STATES['EXPIRED safe_mode'];
    expect(decide(expired, Reservations, 'view')).toBe('allow');
    expect(decide(expired, Reservations, 'create')).toBe('safe_mode_blocked');
  });

  it('module not in the licence: 403 module_not_licensed even in safe mode', () => {
    expect(SAFE_MODE_ALLOWED.has('reservation.view')).toBe(true);
    expect(decide(STATES['EXPIRED safe_mode'], Reservations, 'channelView')).toBe('module_not_licensed');
  });

  it('not activated: 403 not_activated', () => {
    expect(decide(null, Reservations, 'view')).toBe('not_activated');
  });

  it('the denial is a DomainError with a user message and the reason as code', () => {
    const handler = Reservations.prototype.create;
    const ctx = new ExecutionContextHost([{}, {}], Reservations as never, handler);
    let caught: unknown;
    try {
      guardFor(STATES['EXPIRED safe_mode']).canActivate(ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect(caught).toMatchObject({ code: 'safe_mode_blocked', status: 403, details: { module: 'hotel.core', action: 'reservation.create' } });
    expect((caught as DomainError).message).toMatch(/siguran režim|sigurnom režimu/i);
  });

  it('@Unlicensed routes pass in every state, including not activated and INVALID', () => {
    for (const evaluation of Object.values(STATES)) {
      expect(decide(evaluation, Reservations, 'open')).toBe('allow');
      expect(decide(evaluation, OpenByClass, 'inherits')).toBe('allow');
    }
  });

  it('a method annotation overrides the class annotation', () => {
    expect(decide(STATES['EXPIRED safe_mode'], OpenByClass, 'overridden')).toBe('safe_mode_blocked');
  });

  it('a route with neither annotation is denied in every state (fail closed)', () => {
    for (const evaluation of Object.values(STATES)) {
      expect(decide(evaluation, Reservations, 'unannotated')).toBe('route_not_classified');
    }
  });

  it('SAFE_MODE_ALLOWED is exactly the five 1a view actions plus the ten 1b actions', () => {
    expect([...SAFE_MODE_ALLOWED].sort()).toEqual(
      [
        'business_day.close',
        'business_day.view',
        'calendar.view',
        'folio.document',
        'folio.pay',
        'folio.view',
        'guest.view',
        'legal_profile.view',
        'message.view',
        'rate.view',
        'reservation.view',
        'settings.view',
        'stay.check_out',
        'unit.view',
        'user.view',
      ],
    );
    // Changes that are not legal or operational necessities stay out (plan Task 3).
    for (const action of ['stay.check_in', 'guest.manage', 'folio.charge', 'folio.correct', 'settings.manage', 'legal_profile.manage', 'message.resend']) {
      expect(SAFE_MODE_ALLOWED.has(action)).toBe(false);
    }
  });
});
