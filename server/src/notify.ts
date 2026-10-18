import type { FastifyRequest } from 'fastify';
import { getMailer, type MailMessage } from './mail/index.js';

/**
 * Mail about the account itself, sent after the response and only when a mailer exists. Never medical text
 * (SECURITY.md P8): what happened to the account and when, nothing about the records. A failure is logged with the
 * provider's status and never the message.
 */
export function mailAfter(req: FastifyRequest, userId: string, message: MailMessage, what: string): void {
  const mailer = getMailer();
  if (!mailer.enabled) return;
  void mailer.send(message).catch(err => {
    req.log.error({ userId, err: err instanceof Error ? err.message : String(err) }, `could not send ${what} mail`);
  });
}

export function newSignInMail(to: string, at: string): MailMessage {
  return {
    to,
    subject: 'New sign-in to your account',
    text:
      `Your account was signed in from a browser it had not been used from before, at ${at} (UTC).\n\n` +
      `If that was you, there is nothing to do. If it was not, sign in, open Account, end the sign-ins you do not recognise and change your password.\n`,
  };
}

export function securityChangeMail(to: string, what: string, at: string): MailMessage {
  return {
    to,
    subject: 'A security setting on your account changed',
    text:
      `${what} at ${at} (UTC).\n\n` +
      `If that was you, there is nothing to do. If it was not, someone has your password: ask the person who runs this service to reset it and to turn off two-factor sign-in, then sign in and end the sign-ins you do not recognise.\n`,
  };
}
