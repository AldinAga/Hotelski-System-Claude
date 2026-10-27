import { Controller, Get } from '@nestjs/common';
import { LicenceService, type LicenceSnapshot } from './licence.service';
import { Unlicensed } from './licensed-action';

// Works without a licence (the status is what an unlicensed installation needs
// to see). Not @Public: once Task 5's authentication guard exists, it needs a
// signed-in user.
@Controller('licence')
export class LicenceController {
  constructor(private readonly licence: LicenceService) {}

  @Get()
  @Unlicensed()
  status(): LicenceSnapshot {
    return this.licence.snapshot();
  }
}
