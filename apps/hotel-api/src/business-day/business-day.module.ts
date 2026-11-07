import { Module } from '@nestjs/common';
import { BusinessDayController, BusinessSettingsController } from './business-day.controller';
import { BusinessDayService } from './business-day.service';
import { SettingsService } from './settings.service';

// lockOpen (lock order point 0) and the settings are used by the folio,
// check-in/out and the night audit (Tasks 4-6), which import this module.
@Module({
  controllers: [BusinessDayController, BusinessSettingsController],
  providers: [BusinessDayService, SettingsService],
  exports: [BusinessDayService, SettingsService],
})
export class BusinessDayModule {}
