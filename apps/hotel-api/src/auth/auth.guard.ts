import {
  createParamDecorator,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DomainError } from '../common/domain-error';
import type { UserRole } from '../db/schema';
import { SESSION_COOKIE, SessionsService, type AuthUser } from './sessions.service';

export const IS_PUBLIC = 'hotel:public';
export const ROLES = 'hotel:roles';

/** The route needs no signed-in user (health, login, first-run setup). Says nothing about the licence. */
export function Public(): MethodDecorator & ClassDecorator {
  return SetMetadata(IS_PUBLIC, true);
}

/** Only users with one of these roles pass; others get 403 forbidden_role. */
export function Roles(...roles: UserRole[]): MethodDecorator & ClassDecorator {
  if (roles.length === 0) throw new Error('Roles needs at least one role');
  return SetMetadata(ROLES, roles);
}

export type AuthRequest = Request & { user?: AuthUser };

/** The signed-in user; only on routes that are not @Public. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<AuthRequest>().user;
  if (!user) throw new Error('CurrentUser used on a route without AuthGuard');
  return user;
});

/** The value of one cookie from a Cookie header, or null. No cookie-parser needed. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Global (APP_GUARD), registered before LicenceGuard in AppModule so a request
 * without a session is 401 whatever the licence says. Fails closed: every
 * route needs a live session unless it is @Public. @Roles is checked here,
 * after the session, so an anonymous caller learns nothing about roles.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets) === true) return true;

    const req = context.switchToHttp().getRequest<AuthRequest>();
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const user = token ? await this.sessions.authenticate(token) : null;
    if (!user) {
      throw new DomainError('session_required', 'Prijavite se da biste nastavili.', 401);
    }
    req.user = user;

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES, targets);
    if (roles && !roles.includes(user.role)) {
      throw new DomainError('forbidden_role', 'Vaša uloga nema pravo na ovu radnju.', 403, { role: user.role });
    }
    return true;
  }
}
