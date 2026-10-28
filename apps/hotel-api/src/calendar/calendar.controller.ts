import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.guard';
import type { AuthUser } from '../auth/sessions.service';
import { LicensedAction } from '../licensing/licensed-action';
import { CalendarService, type CalendarView } from './calendar.service';

// Read only and open to every signed-in role, also in safe mode. Housekeeping
// sees occupancy only: no guest name, reservation number or reservation id
// (the reservation routes refuse that role, so it has no bookings to open).
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get()
  @LicensedAction('hotel.core', 'calendar.view')
  view(@CurrentUser() user: AuthUser, @Query('from') from: unknown, @Query('to') to: unknown): Promise<CalendarView> {
    return this.calendar.view(from, to, { guestDetails: user.role !== 'housekeeping' });
  }
}
