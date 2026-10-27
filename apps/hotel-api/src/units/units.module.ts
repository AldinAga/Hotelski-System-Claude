import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { LicensingModule } from '../licensing/licensing.module';
import { UnitsController, UnitTypesController } from './units.controller';
import { UnitsService } from './units.service';

@Module({
  imports: [LicensingModule, InventoryModule],
  controllers: [UnitTypesController, UnitsController],
  providers: [UnitsService],
})
export class UnitsModule {}
