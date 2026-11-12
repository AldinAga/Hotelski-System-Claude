import { Module } from '@nestjs/common';
import { LegalProfileController } from './legal-profile.controller';
import { LegalProfileService } from './legal-profile.service';

// LegalProfileService.get is what the documents of Task 8 print as the issuer.
@Module({
  controllers: [LegalProfileController],
  providers: [LegalProfileService],
  exports: [LegalProfileService],
})
export class LegalModule {}
