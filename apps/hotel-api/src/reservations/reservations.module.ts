import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { RatesModule } from '../rates/rates.module';
import { ReservationsController, StaysController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

// ReservationsService.book is the one way any source makes a stay (spec 5.7).
@Module({
  imports: [InventoryModule, RatesModule],
  controllers: [ReservationsController, StaysController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
