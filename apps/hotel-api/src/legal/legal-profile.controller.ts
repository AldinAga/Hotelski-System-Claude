import { Body, Controller, Get, Put } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/auth.guard';
import type { AuthUser } from '../auth/sessions.service';
import { LicensedAction } from '../licensing/licensed-action';
import { LegalProfileService, type LegalProfileView } from './legal-profile.service';

// The legal profile belongs to hotel.core: it is set up with the property.
// Reading works in safe mode (legal_profile.view); changing it does not.
@Controller('legal-profile')
@Roles('owner', 'manager')
export class LegalProfileController {
  constructor(private readonly profile: LegalProfileService) {}

  @Get()
  @LicensedAction('hotel.core', 'legal_profile.view')
  get(): Promise<LegalProfileView> {
    return this.profile.get();
  }

  @Put()
  @LicensedAction('hotel.core', 'legal_profile.manage')
  update(@CurrentUser() actor: AuthUser, @Body() body: unknown): Promise<LegalProfileView> {
    return this.profile.update(body, actor);
  }
}
