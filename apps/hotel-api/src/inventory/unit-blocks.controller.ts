import { Body, Controller, Delete, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/auth.guard';
import type { AuthUser } from '../auth/sessions.service';
import { LicensedAction } from '../licensing/licensed-action';
import { UnitBlocksService, type UnitBlockView } from './unit-blocks.service';

@Controller('units/:unitId/blocks')
@LicensedAction('hotel.core', 'unit.manage')
@Roles('owner', 'manager')
export class UnitBlocksController {
  constructor(private readonly blocks: UnitBlocksService) {}

  @Post()
  create(
    @CurrentUser() actor: AuthUser,
    @Param('unitId') unitId: string,
    @Body() body: unknown,
  ): Promise<UnitBlockView> {
    return this.blocks.create(actor, unitId, body);
  }

  @Delete(':blockId')
  @HttpCode(204)
  remove(
    @CurrentUser() actor: AuthUser,
    @Param('unitId') unitId: string,
    @Param('blockId') blockId: string,
  ): Promise<void> {
    return this.blocks.remove(actor, unitId, blockId);
  }
}
