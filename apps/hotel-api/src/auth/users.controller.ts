import { Body, Controller, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { LicensedAction } from '../licensing/licensed-action';
import { CurrentUser, Roles } from './auth.guard';
import type { AuthUser } from './sessions.service';
import { UsersService, type UserView } from './users.service';

@Controller('users')
@LicensedAction('hotel.core', 'user.manage')
@Roles('owner', 'manager')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  create(@CurrentUser() actor: AuthUser, @Body() body: unknown): Promise<UserView> {
    return this.users.create(actor, body);
  }

  @Patch(':id')
  update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown): Promise<UserView> {
    return this.users.update(actor, id, body);
  }

  @Post(':id/reset-totp')
  @Roles('owner')
  @HttpCode(200)
  resetTotp(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<{ totpUri: string }> {
    return this.users.resetTotp(actor, id);
  }
}
