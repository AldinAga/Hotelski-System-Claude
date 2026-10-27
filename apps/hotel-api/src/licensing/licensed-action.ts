import { SetMetadata } from '@nestjs/common';

export const LICENSED_ACTION = 'hotel:licensed-action';
export const UNLICENSED = 'hotel:unlicensed';

export interface LicensedActionMeta {
  module: string;
  action: string;
}

/**
 * The route performs `action` of licence module `module`; LicenceGuard lets it
 * through only when the access resolver allows that pair (SPEC section 7).
 * Every route carries this or @Unlicensed(); a route with neither is refused.
 */
export function LicensedAction(module: string, action: string): MethodDecorator & ClassDecorator {
  if (!module.trim() || !action.trim()) throw new Error('LicensedAction needs a module and an action');
  return SetMetadata<string, LicensedActionMeta>(LICENSED_ACTION, { module, action });
}

/**
 * The route works without a licence (health, setup, login, the licence
 * status itself). Says nothing about authentication.
 */
export function Unlicensed(): MethodDecorator & ClassDecorator {
  return SetMetadata(UNLICENSED, true);
}
