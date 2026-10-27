import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { UnitBlocksController } from './unit-blocks.controller';
import { UnitBlocksService } from './unit-blocks.service';

// InventoryService is the only writer of inventory_day; other modules import
// this one and call it inside their own transactions.
@Module({
  controllers: [UnitBlocksController],
  providers: [InventoryService, UnitBlocksService],
  exports: [InventoryService],
})
export class InventoryModule {}
