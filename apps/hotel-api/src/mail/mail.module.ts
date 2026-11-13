import { Logger, Module } from '@nestjs/common';
import { MessagesController } from './messages.controller';
import { MAIL_FROM, MAIL_TRANSPORT } from './mail-transport';
import { OutboxDispatcher } from './outbox.dispatcher';
import { OutboxService } from './outbox.service';
import { createMailTransport } from './smtp.transport';

// ReservationsModule imports this module (bookIn and cancel queue the
// messages); this module never imports ReservationsModule. Only main.ts starts
// the dispatcher.
@Module({
  controllers: [MessagesController],
  providers: [
    {
      provide: MAIL_TRANSPORT,
      useFactory: () => {
        const log = new Logger('Mail');
        return createMailTransport(process.env, (line) => log.warn(line));
      },
    },
    { provide: MAIL_FROM, useFactory: (): string => process.env.MAIL_FROM?.trim() ?? '' },
    OutboxService,
    OutboxDispatcher,
  ],
  exports: [OutboxService, OutboxDispatcher],
})
export class MailModule {}
