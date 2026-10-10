import { MailerDisabledError, type Mailer } from '../types.js';

/**
 * The default. Sends nothing; recovery falls back to the operator CLI, and open
 * registration cannot be enabled with it (config refuses to start).
 */
export function createNoneMailer(): Mailer {
  return {
    enabled: false,
    async send() {
      throw new MailerDisabledError();
    },
  };
}
