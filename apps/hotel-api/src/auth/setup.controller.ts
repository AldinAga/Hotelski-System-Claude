import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Unlicensed } from '../licensing/licensed-action';
import { Public } from './auth.guard';
import { SetupService, type SetupStatus } from './setup.service';

// Before setup there is neither a user nor a licence: the setup token from the
// boot log is what authorises these calls. All of them answer 410 setup_done
// once the owner exists.
@Controller('setup')
@Public()
@Unlicensed()
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  @Get('status')
  status(): Promise<SetupStatus> {
    return this.setup.status();
  }

  @Post('activate')
  @HttpCode(200)
  async activate(@Body() body: unknown): Promise<{ activated: true }> {
    await this.setup.activate(body);
    return { activated: true };
  }

  @Post('owner')
  owner(@Body() body: unknown): Promise<{ totpUri: string }> {
    return this.setup.createOwner(body);
  }
}
