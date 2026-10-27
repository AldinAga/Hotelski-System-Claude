import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ActivationService } from './activation.service';
import { LicenceController } from './licence.controller';
import { LicenceGuard } from './licence.guard';
import { LicenceService } from './licence.service';
import { LicenceStore } from './licence.store';
import { LICENSING_CONFIG, loadLicensingConfig, type LicensingConfig } from './licensing.config';

// Reads the licensing environment once at boot. Missing parts leave licensing
// unconfigured (503 on activation); a present but wrong value stops the boot.
// LicenceGuard is global: every route of the app passes through it.
@Module({
  controllers: [LicenceController],
  providers: [
    { provide: LICENSING_CONFIG, useFactory: (): LicensingConfig => loadLicensingConfig(process.env) },
    LicenceStore,
    ActivationService,
    LicenceService,
    { provide: APP_GUARD, useClass: LicenceGuard },
  ],
  exports: [LICENSING_CONFIG, LicenceStore, ActivationService, LicenceService],
})
export class LicensingModule {}
