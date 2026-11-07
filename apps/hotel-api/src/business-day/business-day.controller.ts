import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/auth.guard';
import type { AuthUser } from '../auth/sessions.service';
import { LicensedAction } from '../licensing/licensed-action';
import { BusinessDayService, type BusinessDayView } from './business-day.service';
import { SettingsService, type PropertySettings } from './settings.service';

// Both are hotel.folio (preflight F29): the business day, the automatic close
// and the VAT rates belong to the folio. Reading works in safe mode
// (business_day.view, settings.view); changing settings does not. Closing the
// day (POST /business-day/close) arrives with the night audit (Task 6).

@Controller('business-day')
@Roles('owner', 'manager', 'receptionist')
export class BusinessDayController {
  constructor(private readonly days: BusinessDayService) {}

  @Get()
  @LicensedAction('hotel.folio', 'business_day.view')
  view(): Promise<BusinessDayView> {
    return this.days.view();
  }
}

@Controller('settings/business')
@Roles('owner', 'manager')
export class BusinessSettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @LicensedAction('hotel.folio', 'settings.view')
  get(): Promise<PropertySettings> {
    return this.settings.get();
  }

  @Put()
  @LicensedAction('hotel.folio', 'settings.manage')
  update(@CurrentUser() actor: AuthUser, @Body() body: unknown): Promise<PropertySettings> {
    return this.settings.update(body, actor);
  }
}
