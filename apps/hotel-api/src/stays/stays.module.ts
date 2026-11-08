import { Module } from '@nestjs/common';
import { BusinessDayModule } from '../business-day/business-day.module';
import { FolioModule } from '../folio/folio.module';
import { GuestsModule } from '../guests/guests.module';
import { InventoryModule } from '../inventory/inventory.module';
import { StayLifecycleController } from './stay-lifecycle.controller';
import { StayLifecycleService } from './stay-lifecycle.service';

// Check-in and check-out (Task 5): the business day (lockOpen), the folio,
// the primary guest and, for an early departure, the inventory.
@Module({
  imports: [BusinessDayModule, FolioModule, GuestsModule, InventoryModule],
  controllers: [StayLifecycleController],
  providers: [StayLifecycleService],
  exports: [StayLifecycleService],
})
export class StaysModule {}
