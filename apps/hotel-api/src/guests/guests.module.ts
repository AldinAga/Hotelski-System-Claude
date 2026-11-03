import { Module } from '@nestjs/common';
import { GuestsController, StayGuestsController } from './guests.controller';
import { GuestsService } from './guests.service';

// GuestsService.ensurePrimary is used by check-in (StaysModule, Task 5).
@Module({
  controllers: [GuestsController, StayGuestsController],
  providers: [GuestsService],
  exports: [GuestsService],
})
export class GuestsModule {}
