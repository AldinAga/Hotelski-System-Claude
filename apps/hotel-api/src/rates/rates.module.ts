import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { RatesController } from './rates.controller';
import { RatesService } from './rates.service';

// Reservations import this module and price stays through RatesService.quote.
@Module({
  imports: [InventoryModule],
  controllers: [RatesController],
  providers: [RatesService],
  exports: [RatesService],
})
export class RatesModule {}
