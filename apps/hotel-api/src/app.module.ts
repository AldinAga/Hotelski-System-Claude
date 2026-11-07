import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { BusinessDayModule } from './business-day/business-day.module';
import { CalendarModule } from './calendar/calendar.module';
import { DatabaseModule } from './db/database.module';
import { GuestsModule } from './guests/guests.module';
import { HealthController } from './health.controller';
import { InventoryModule } from './inventory/inventory.module';
import { LicenceGuard } from './licensing/licence.guard';
import { LicensingModule } from './licensing/licensing.module';
import { RatesModule } from './rates/rates.module';
import { ReservationsModule } from './reservations/reservations.module';
import { UnitsModule } from './units/units.module';

// The two global guards, in the order Nest runs them: who you are first
// (401 without a session, unless @Public), then whether the licence allows
// the route (@LicensedAction / @Unlicensed). Keep this order: an anonymous
// caller must get 401, not a licence answer. test/auth.e2e-spec.ts pins it.
@Module({
  imports: [DatabaseModule, LicensingModule, AuthModule, InventoryModule, UnitsModule, RatesModule, ReservationsModule, CalendarModule, GuestsModule, BusinessDayModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: LicenceGuard },
  ],
})
export class AppModule {}
