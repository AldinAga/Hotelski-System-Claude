import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CurrentUser, Roles } from '../auth/auth.guard';
import type { AuthUser } from '../auth/sessions.service';
import { LicensedAction } from '../licensing/licensed-action';
import { OutboxService, type MessageView } from './outbox.service';

// The e-mails of a reservation, for the front desk (receptionist, manager,
// owner; housekeeping does not see guests' correspondence). Reading keeps
// working in safe mode (message.view); a resend does not (message.resend).

@Controller()
@Roles('owner', 'manager', 'receptionist')
export class MessagesController {
  constructor(private readonly outbox: OutboxService) {}

  @Get('reservations/:id/messages')
  @LicensedAction('hotel.core', 'message.view')
  list(@Param('id') id: string): Promise<MessageView[]> {
    return this.outbox.forReservation(id);
  }

  @Post('messages/:id/resend')
  @HttpCode(200)
  @LicensedAction('hotel.core', 'message.resend')
  resend(@CurrentUser() actor: AuthUser, @Param('id') id: string): Promise<MessageView> {
    return this.outbox.resend(id, actor);
  }
}
