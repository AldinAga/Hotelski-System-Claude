import { Logger, Module } from '@nestjs/common';
import { LicensingModule } from '../licensing/licensing.module';
import { AuthController } from './auth.controller';
import { SessionsService } from './sessions.service';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';
import { loadTurnstileConfig, TURNSTILE_CONFIG, TurnstileService, type TurnstileConfig } from './turnstile';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

// AuthGuard is registered as a global guard in AppModule, next to
// LicenceGuard, where their order is stated.
@Module({
  imports: [LicensingModule],
  controllers: [AuthController, UsersController, SetupController],
  providers: [
    SessionsService,
    UsersService,
    SetupService,
    TurnstileService,
    {
      provide: TURNSTILE_CONFIG,
      useFactory: (): TurnstileConfig | null =>
        loadTurnstileConfig(process.env, (line) => new Logger('Turnstile').warn(line)),
    },
  ],
  exports: [SessionsService, SetupService],
})
export class AuthModule {}
