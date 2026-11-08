import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/auth.guard';
import type { AuthUser } from '../auth/sessions.service';
import { asBody } from '../common/input';
import { LicensedAction } from '../licensing/licensed-action';
import { StayLifecycleService, type CheckOutPreview } from './stay-lifecycle.service';

// Check-in and check-out, hotel.core, for the front desk (receptionist,
// manager, owner). In safe mode stay.check_out keeps working (the guests in
// the house leave, SAFE_MODE_ALLOWED), its preview included; stay.check_in
// does not (nobody new moves in).

@Controller('stays')
@Roles('owner', 'manager', 'receptionist')
export class StayLifecycleController {
  constructor(private readonly stays: StayLifecycleService) {}

  @Post(':id/check-in')
  @HttpCode(200)
  @LicensedAction('hotel.core', 'stay.check_in')
  checkIn(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.stays.checkIn(id, asBody(body).version, actor);
  }

  // Reads only, but it is the first step of a check-out, so it carries that action.
  @Get(':id/check-out-preview')
  @LicensedAction('hotel.core', 'stay.check_out')
  checkOutPreview(@Param('id') id: string): Promise<CheckOutPreview> {
    return this.stays.checkOutPreview(id);
  }

  @Post(':id/check-out')
  @HttpCode(200)
  @LicensedAction('hotel.core', 'stay.check_out')
  checkOut(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.stays.checkOut(id, asBody(body).version, actor);
  }
}
