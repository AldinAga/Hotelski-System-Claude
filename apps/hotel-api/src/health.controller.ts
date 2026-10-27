import { Controller, Get } from '@nestjs/common';
import { Unlicensed } from './licensing/licensed-action';

// Liveness must answer without a licence. Task 5 adds @Public().
@Controller('health')
export class HealthController {
  @Get()
  @Unlicensed()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
