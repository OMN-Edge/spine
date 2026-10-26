/**
 * The mailer interface. It exists for account messages only: verifying an address,
 * recovering an account, a notice of a new sign-in or a changed security setting, and
 * a request waiting for approval. Nothing else in the application sends mail.
 *
 * There is deliberately no attachment field and no way to add one. Mail carries a
 * recipient address, a link and when an account event happened, never
 * document text, a summary or a field (SECURITY.md P8) — and omitting the capability is what keeps a medical
 * document from one day leaving by accident.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** False for the `none` adapter. Callers check this rather than catching a throw. */
  readonly enabled: boolean;
  /** Rejects on any failure; the caller decides what the user is told. */
  send(message: MailMessage): Promise<void>;
}

export interface MailerConfig {
  adapter: string;
  apiKey?: string;
  /** `name@example.com` or `Display Name <name@example.com>`. */
  sender?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export type MailerFactory = (config: MailerConfig) => Mailer;

export class MailerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailerConfigError';
  }
}

export class MailerDisabledError extends Error {
  constructor() {
    super('no mailer is configured (SPINE_MAILER=none)');
    this.name = 'MailerDisabledError';
  }
}
