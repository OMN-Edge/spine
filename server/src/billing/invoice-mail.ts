import { publicUrl } from 'spine-core/config.js';
import { composeMail } from '../mail/layout.js';
import type { MailMessage } from '../mail/index.js';
import { recipientLanguage, tm, type Recipient } from '../mail/i18n.js';

/**
 * What a buyer is told when Spine has made their invoice, or a credit note for a refund: its number and where it is (the account page, which makes the PDF when it is asked
 * for). No attachment, no amount and nothing of the records, as with all of Spine's mail.
 */
export function invoiceReadyMail(to: Recipient, number: string, credit: boolean): MailMessage {
  const lang = recipientLanguage(to);
  const subject = credit ? tm(lang, 'Your credit note {number} is ready', { number }) : tm(lang, 'Your invoice {number} is ready', { number });
  return composeMail({
    to,
    subject,
    heading: subject,
    intro: [credit ? tm(lang, 'We made a credit note {number} for your refund.', { number }) : tm(lang, 'We made the invoice {number} for your purchase.', { number }), tm(lang, 'You can download it as a PDF from your account page, under Invoices.')],
    action: { label: tm(lang, 'Open Spine'), url: publicUrl('/account') },
    outro: [tm(lang, 'A company also finds it in its ANAF space (SPV).')],
  });
}
