import { Module } from '@nestjs/common';
import { DatabaseModule } from './db/database.module';
import { HealthController } from './health.controller';
import { LicensingModule } from './licensing/licensing.module';

@Module({
  imports: [DatabaseModule, LicensingModule],
  controllers: [HealthController],
})
export class AppModule {}
