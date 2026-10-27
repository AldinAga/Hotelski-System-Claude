import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/auth.guard';
import { Unlicensed } from './licensing/licensed-action';

// Liveness must answer without a licence and without a user.
@Controller('health')
export class HealthController {
  @Get()
  @Public()
  @Unlicensed()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
