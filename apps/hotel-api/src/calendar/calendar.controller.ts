import { Controller, Get, Query } from '@nestjs/common';
import { LicensedAction } from '../licensing/licensed-action';
import { CalendarService, type CalendarView } from './calendar.service';

// Read only and open to every signed-in role, also in safe mode.
@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get()
  @LicensedAction('hotel.core', 'calendar.view')
  view(@Query('from') from: unknown, @Query('to') to: unknown): Promise<CalendarView> {
    return this.calendar.view(from, to);
  }
}
