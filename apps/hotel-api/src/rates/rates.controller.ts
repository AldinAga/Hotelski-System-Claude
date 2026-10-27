import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/auth.guard';
import type { AuthUser } from '../auth/sessions.service';
import { LicensedAction } from '../licensing/licensed-action';
import { RatesService, type RateDayView, type RatePlanView } from './rates.service';

// Reading is open to every signed-in role (and to safe mode); changes are
// owner and manager only.

@Controller('rate-plans')
export class RatesController {
  constructor(private readonly rates: RatesService) {}

  @Get()
  @LicensedAction('hotel.core', 'rate.view')
  list(): Promise<RatePlanView[]> {
    return this.rates.listPlans();
  }

  @Post()
  @LicensedAction('hotel.core', 'rate.manage')
  @Roles('owner', 'manager')
  create(@CurrentUser() actor: AuthUser, @Body() body: unknown): Promise<RatePlanView> {
    return this.rates.createPlan(actor, body);
  }

  @Patch(':id')
  @LicensedAction('hotel.core', 'rate.manage')
  @Roles('owner', 'manager')
  update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown): Promise<RatePlanView> {
    return this.rates.updatePlan(actor, id, body);
  }

  @Get(':id/days')
  @LicensedAction('hotel.core', 'rate.view')
  days(
    @Param('id') id: string,
    @Query('scope') scope: unknown,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
  ): Promise<RateDayView[]> {
    return this.rates.listDays(id, { scope, from, to });
  }

  @Put(':id/days')
  @LicensedAction('hotel.core', 'rate.manage')
  @Roles('owner', 'manager')
  setDays(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown): Promise<{ days: number }> {
    return this.rates.setDays(actor, id, body);
  }
}
