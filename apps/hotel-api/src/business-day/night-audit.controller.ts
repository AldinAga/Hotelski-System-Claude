import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/auth.guard';
import type { AuthUser } from '../auth/sessions.service';
import { asBody } from '../common/input';
import { LicensedAction } from '../licensing/licensed-action';
import { NightAuditService, type ClosedDay, type ClosedDaySummary, type CloseResult } from './night-audit.service';

// The night audit routes, hotel.folio, for the front desk (receptionist,
// manager, owner). Closing the day works in safe mode (Ruling 5:
// business_day.close is in SAFE_MODE_ALLOWED), and so does reading closed days.
// A close of a day that is already closed answers 200 with its stored report.

@Controller()
@Roles('owner', 'manager', 'receptionist')
export class NightAuditController {
  constructor(private readonly audit: NightAuditService) {}

  @Post('business-day/close')
  @HttpCode(200)
  @LicensedAction('hotel.folio', 'business_day.close')
  close(@CurrentUser() actor: AuthUser, @Body() body: unknown): Promise<CloseResult> {
    return this.audit.close(asBody(body).day, actor, 'manual');
  }

  @Get('business-days')
  @LicensedAction('hotel.folio', 'business_day.view')
  list(@Query('from') from: unknown, @Query('to') to: unknown): Promise<ClosedDaySummary[]> {
    return this.audit.list(from, to);
  }

  @Get('business-days/:day')
  @LicensedAction('hotel.folio', 'business_day.view')
  get(@Param('day') day: string): Promise<ClosedDay> {
    return this.audit.get(day);
  }
}
