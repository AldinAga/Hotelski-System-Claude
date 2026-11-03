import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/auth.guard';
import type { AuthUser } from '../auth/sessions.service';
import { LicensedAction } from '../licensing/licensed-action';
import { GuestsService, type GuestView, type StayGuestView } from './guests.service';

// The front desk (receptionist, manager, owner) finds and records guests;
// housekeeping does not see them. Reading keeps working in safe mode
// (guest.view is in SAFE_MODE_ALLOWED); every change is guest.manage.

@Controller('guests')
@Roles('owner', 'manager', 'receptionist')
export class GuestsController {
  constructor(private readonly guests: GuestsService) {}

  @Get()
  @LicensedAction('hotel.core', 'guest.view')
  search(@Query('q') q: unknown): Promise<GuestView[]> {
    return this.guests.search(q);
  }

  @Post()
  @LicensedAction('hotel.core', 'guest.manage')
  create(@CurrentUser() actor: AuthUser, @Body() body: unknown): Promise<GuestView> {
    return this.guests.create(body, actor);
  }

  @Patch(':id')
  @LicensedAction('hotel.core', 'guest.manage')
  update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown): Promise<GuestView> {
    return this.guests.update(id, body, actor);
  }
}

@Controller('stays/:id/guests')
@Roles('owner', 'manager', 'receptionist')
export class StayGuestsController {
  constructor(private readonly guests: GuestsService) {}

  @Post()
  @LicensedAction('hotel.core', 'guest.manage')
  add(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown): Promise<StayGuestView[]> {
    return this.guests.addToStay(id, body, actor);
  }

  @Delete(':guestId')
  @LicensedAction('hotel.core', 'guest.manage')
  remove(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Param('guestId') guestId: string): Promise<StayGuestView[]> {
    return this.guests.removeFromStay(id, guestId, actor);
  }

  @Post(':guestId/primary')
  @HttpCode(200)
  @LicensedAction('hotel.core', 'guest.manage')
  setPrimary(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Param('guestId') guestId: string): Promise<StayGuestView[]> {
    return this.guests.setPrimary(id, guestId, actor);
  }
}
