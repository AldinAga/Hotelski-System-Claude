import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/auth.guard';
import type { AuthUser } from '../auth/sessions.service';
import { LicensedAction } from '../licensing/licensed-action';
import { UnitsService, type UnitTypeView, type UnitView } from './units.service';

// Reading is open to every signed-in role; changes are owner and manager only.

@Controller('unit-types')
export class UnitTypesController {
  constructor(private readonly units: UnitsService) {}

  @Get()
  @LicensedAction('hotel.core', 'unit.view')
  list(): Promise<UnitTypeView[]> {
    return this.units.listTypes();
  }

  @Post()
  @LicensedAction('hotel.core', 'unit.manage')
  @Roles('owner', 'manager')
  create(@CurrentUser() actor: AuthUser, @Body() body: unknown): Promise<UnitTypeView> {
    return this.units.createType(actor, body);
  }

  @Patch(':id')
  @LicensedAction('hotel.core', 'unit.manage')
  @Roles('owner', 'manager')
  update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown): Promise<UnitTypeView> {
    return this.units.updateType(actor, id, body);
  }
}

@Controller('units')
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  @Get()
  @LicensedAction('hotel.core', 'unit.view')
  list(): Promise<UnitView[]> {
    return this.units.listUnits();
  }

  @Post()
  @LicensedAction('hotel.core', 'unit.manage')
  @Roles('owner', 'manager')
  create(@CurrentUser() actor: AuthUser, @Body() body: unknown): Promise<UnitView> {
    return this.units.createUnit(actor, body);
  }

  @Patch(':id')
  @LicensedAction('hotel.core', 'unit.manage')
  @Roles('owner', 'manager')
  update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() body: unknown): Promise<UnitView> {
    return this.units.updateUnit(actor, id, body);
  }
}
