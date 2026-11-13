export interface MailMessage {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
}

/** A failed send. `permanent` (a 5xx answer) is never retried; its message is stored and shown to the front desk. */
export class MailError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'MailError';
  }
}

export interface MailTransport {
  readonly configured: boolean;
  send(m: MailMessage): Promise<void>;
}

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
/** The From header of every message (the MAIL_FROM environment variable). */
export const MAIL_FROM = Symbol('MAIL_FROM');

/** Used while SMTP is not set up: every send fails (temporarily), so the message stays visible and can be resent. */
export class NoopMailTransport implements MailTransport {
  readonly configured = false;

  send(): Promise<void> {
    return Promise.reject(new MailError('smtp_not_configured', 'SMTP nije podešen.', false));
  }
}
