import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { asBody } from '../common/input';
import { Unlicensed } from '../licensing/licensed-action';
import { CurrentUser, Public } from './auth.guard';
import { SESSION_COOKIE, SessionsService, type AuthUser, type PublicUser } from './sessions.service';

// HttpOnly keeps the token from scripts. SameSite=Strict keeps other *sites*
// from sending it, but SameSite ignores ports: every app on the same host
// (Admin Panel, POS, Portainer, hotel-hub on 192.168.1.199) is the same site
// and its pages would send this cookie. Cross-site request forgery is closed
// by src/http.ts instead (JSON bodies only, unsafe methods refused from a
// foreign Origin/Sec-Fetch-Site). Production gets its own hostname.
// Secure when the request is https, also behind the Next rewrite or another
// trusted proxy: req.secure reads X-Forwarded-Proto there (trust proxy, src/http.ts).
function cookieOptions(req: Request): CookieOptions {
  return { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' };
}

@Controller('auth')
@Unlicensed()
export class AuthController {
  constructor(private readonly sessions: SessionsService) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicUser> {
    const b = asBody(body);
    const { token, absoluteExpiresAt, user } = await this.sessions.login(b.email, b.password, b.totp);
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req), expires: absoluteExpiresAt });
    return user;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.sessions.logout(user);
    res.clearCookie(SESSION_COOKIE, cookieOptions(req));
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): PublicUser {
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }
}
