import { Module } from '@nestjs/common';
import { FolioModule } from '../folio/folio.module';
import { InventoryModule } from '../inventory/inventory.module';
import { LicensingModule } from '../licensing/licensing.module';
import { BusinessDayModule } from './business-day.module';
import { NightAuditController } from './night-audit.controller';
import { NightAuditScheduler } from './night-audit.scheduler';
import { NightAuditService } from './night-audit.service';

// The night audit (Task 6) in its own module (preflight F7): it needs the
// folio, and FolioModule already imports BusinessDayModule, so putting it in
// BusinessDayModule would make a cycle. No forwardRef.
@Module({
  imports: [BusinessDayModule, FolioModule, InventoryModule, LicensingModule],
  controllers: [NightAuditController],
  providers: [NightAuditService, NightAuditScheduler],
  exports: [NightAuditScheduler],
})
export class NightAuditModule {}
