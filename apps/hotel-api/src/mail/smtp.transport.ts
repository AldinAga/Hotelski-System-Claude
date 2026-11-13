import { createTransport, type Transporter } from 'nodemailer';
import { MailError, NoopMailTransport, type MailMessage, type MailTransport } from './mail-transport';

// SMTP through nodemailer. The text of a failure is fixed Serbian text plus the
// SMTP code: what the server said (it may echo addresses or credentials) never
// reaches last_error, the attempt history, the API or the log.

export const SMTP_TIMEOUT_MS = 20_000;

export interface SmtpOptions {
  host: string;
  port: number;
  /** true: TLS from the first byte (port 465); false: plain, upgraded with STARTTLS when the server offers it. */
  secure: boolean;
  user?: string;
  password?: string;
}

/** 5xx answers are permanent; 4xx, network errors and timeouts are not. */
export function toMailError(err: unknown): MailError {
  const raw = (err as { responseCode?: unknown } | null)?.responseCode;
  const code = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
  if (Number.isInteger(code) && code >= 500 && code <= 599) {
    return new MailError(`smtp_${code}`, `SMTP server je odbio poruku (odgovor ${code}).`, true);
  }
  if (Number.isInteger(code) && code >= 400 && code <= 499) {
    return new MailError(`smtp_${code}`, `SMTP server trenutno ne prima poruku (odgovor ${code}).`, false);
  }
  return new MailError('smtp_connection', 'Veza sa SMTP serverom nije uspela.', false);
}

export class SmtpMailTransport implements MailTransport {
  readonly configured = true;
  private readonly transporter: Transporter;

  constructor(opts: SmtpOptions) {
    this.transporter = createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      ...(opts.user ? { auth: { user: opts.user, pass: opts.password ?? '' } } : {}),
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    });
  }

  async send(m: MailMessage): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: m.from,
        to: m.to,
        ...(m.replyTo ? { replyTo: m.replyTo } : {}),
        subject: m.subject,
        text: m.text,
        html: m.html,
        messageId: m.messageId,
      });
    } catch (err) {
      throw toMailError(err);
    }
  }
}

/**
 * The transport the environment asks for. Without SMTP_HOST or MAIL_FROM (or
 * with an unusable SMTP_PORT) messages are queued but cannot leave: Noop and
 * one log line that names the variable, never a value.
 */
export function createMailTransport(env: Record<string, string | undefined>, log: (line: string) => void): MailTransport {
  const host = env.SMTP_HOST?.trim();
  const from = env.MAIL_FROM?.trim();
  if (!host) {
    log('SMTP_HOST nije podešen: e-mail poruke se čuvaju u izlaznom sandučetu, ali se ne šalju.');
    return new NoopMailTransport();
  }
  if (!from) {
    log('MAIL_FROM nije podešen: e-mail poruke se čuvaju u izlaznom sandučetu, ali se ne šalju.');
    return new NoopMailTransport();
  }
  const portText = env.SMTP_PORT?.trim() || '587';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65_535) {
    log('SMTP_PORT nije ispravan: e-mail poruke se čuvaju u izlaznom sandučetu, ali se ne šalju.');
    return new NoopMailTransport();
  }
  return new SmtpMailTransport({
    host,
    port,
    secure: env.SMTP_SECURE?.trim().toLowerCase() === 'true',
    user: env.SMTP_USER?.trim() || undefined,
    password: env.SMTP_PASSWORD || undefined,
  });
}
