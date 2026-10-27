import { Module } from '@nestjs/common';
import { ActivationService } from './activation.service';
import { LicenceStore } from './licence.store';
import { LICENSING_CONFIG, loadLicensingConfig, type LicensingConfig } from './licensing.config';

// Reads the licensing environment once at boot. Missing parts leave licensing
// unconfigured (503 on activation); a present but wrong value stops the boot.
@Module({
  providers: [
    { provide: LICENSING_CONFIG, useFactory: (): LicensingConfig => loadLicensingConfig(process.env) },
    LicenceStore,
    ActivationService,
  ],
  exports: [LICENSING_CONFIG, LicenceStore, ActivationService],
})
export class LicensingModule {}
