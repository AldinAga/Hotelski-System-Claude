import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createAccessResolver } from '@platform/licensing';
import { DomainError } from '../common/domain-error';
import { LicenceService } from './licence.service';
import { LICENSED_ACTION, UNLICENSED, type LicensedActionMeta } from './licensed-action';
import { SAFE_MODE_ALLOWED } from './safe-mode';

const MESSAGES: Record<string, string> = {
  not_activated: 'Instalacija još nije aktivirana.',
  invalid_license: 'Licenca nije ispravna. Obratite se podršci.',
  module_not_licensed: 'Ovaj modul nije uključen u licencu.',
  safe_mode_blocked: 'Licenca je istekla; u sigurnom režimu ova radnja nije dozvoljena.',
  expired_hard_lock: 'Licenca je istekla.',
  route_not_classified: 'Ova ruta nije razvrstana za licencu.',
};

function deny(code: string, details?: Record<string, unknown>): DomainError {
  return new DomainError(code, MESSAGES[code] ?? 'Pristup nije dozvoljen licencom.', 403, details);
}

/**
 * Global (APP_GUARD): every route must say what it is. @LicensedAction goes
 * through the SPEC section 7 resolver; @Unlicensed passes; a route with
 * neither is refused, so a forgotten annotation fails closed. A method's
 * annotation wins over its controller's.
 */
@Injectable()
export class LicenceGuard implements CanActivate {
  private readonly resolve = createAccessResolver({ safeModeAllowed: SAFE_MODE_ALLOWED });

  constructor(
    private readonly reflector: Reflector,
    private readonly licence: LicenceService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const controller = context.getClass();
    for (const target of [handler, controller]) {
      const action = this.reflector.get<LicensedActionMeta | undefined>(LICENSED_ACTION, target);
      if (action) return this.check(action);
      if (this.reflector.get<boolean | undefined>(UNLICENSED, target) === true) return true;
    }
    throw deny('route_not_classified');
  }

  private check({ module, action }: LicensedActionMeta): true {
    const evaluation = this.licence.evaluation();
    if (!evaluation) throw deny('not_activated', { module, action });
    const decision = this.resolve(evaluation, { module, action });
    if (!decision.allowed) throw deny(decision.reason, { module, action });
    return true;
  }
}
