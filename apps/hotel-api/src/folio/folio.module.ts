import { Module } from '@nestjs/common';
import { BusinessDayModule } from '../business-day/business-day.module';
import { FolioController } from './folio.controller';
import { FolioService } from './folio.service';

// FolioService (ensureFolio, balanceOf, postNight) is used by check-in/out
// (Task 5) and by the night audit (NightAuditModule, Task 6, preflight F7),
// which import this module; FolioModule itself imports only BusinessDayModule.
@Module({
  imports: [BusinessDayModule],
  controllers: [FolioController],
  providers: [FolioService],
  exports: [FolioService],
})
export class FolioModule {}
