import { Module } from '@nestjs/common';
import { BusinessDayModule } from '../business-day/business-day.module';
import { LegalModule } from '../legal/legal.module';
import { DocumentsService } from './documents.service';
import { FolioController } from './folio.controller';
import { FolioService } from './folio.service';

// FolioService (ensureFolio, balanceOf, postNight) is used by check-in/out
// (Task 5) and by the night audit (NightAuditModule, Task 6, preflight F7),
// which import this module. FolioModule imports BusinessDayModule (lockOpen,
// settings) and LegalModule (the issuer of the documents, Task 8, and the
// fiscal notice of the folio view, preflight F8).
@Module({
  imports: [BusinessDayModule, LegalModule],
  controllers: [FolioController],
  providers: [FolioService, DocumentsService],
  exports: [FolioService],
})
export class FolioModule {}
