import { MailerConfigError, type Mailer, type MailerConfig } from '../types.js';

const ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const TIMEOUT_MS = 10_000;

/** `Name <a@b.c>` or `a@b.c` → `{ name?, email }`. */
export function parseSender(sender: string): { name?: string; email: string } {
  const match = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>\s*$/.exec(sender);
  if (match) return { name: match[1] || undefined, email: match[2] };
  if (/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(sender.trim())) return { email: sender.trim() };
  throw new MailerConfigError(
    `SPINE_MAIL_SENDER "${sender}" is not "name@example.com" or "Name <name@example.com>"`,
  );
}

/**
 * Brevo's transactional API (formerly Sendinblue; French, EU data centres).
 * Confirm its DPA before relying on it for residency — see ARCHITECTURE.md.
 *
 * One request, no retry: sending is user-triggered and can be repeated, and a
 * silent retry could mail the same link twice. Errors say what failed but never
 * include the message, which holds a live link.
 */
export function createBrevoMailer(config: MailerConfig): Mailer {
  if (!config.apiKey) throw new MailerConfigError('SPINE_MAILER=brevo requires BREVO_API_KEY');
  if (!config.sender) throw new MailerConfigError('SPINE_MAILER=brevo requires SPINE_MAIL_SENDER');

  const sender = parseSender(config.sender);
  const apiKey = config.apiKey;
  const doFetch = config.fetchImpl ?? fetch;

  return {
    enabled: true,

    async send(message) {
      const res = await doFetch(ENDPOINT, {
        method: 'POST',
        headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender,
          to: [{ email: message.to }],
          subject: message.subject,
          textContent: message.text,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        // The status is enough to act on; the body can echo the recipient.
        throw new Error(`Brevo rejected the message with status ${res.status}`);
      }
    },
  };
}
