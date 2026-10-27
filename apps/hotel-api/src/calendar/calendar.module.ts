import { Module } from '@nestjs/common';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';

// Reads units, stays, blocks and inventory_day; writes nothing.
@Module({
  controllers: [CalendarController],
  providers: [CalendarService],
})
export class CalendarModule {}
