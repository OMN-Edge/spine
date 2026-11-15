import { publicUrl } from 'spine-core/config.js';
import { composeMail } from '../mail/layout.js';
import type { MailMessage } from '../mail/index.js';
import { recipientLanguage, tm, type Recipient } from '../mail/i18n.js';

/**
 * What a buyer is told of a withdrawal from a purchase (the EU's fourteen days): that it was received, which is the confirmation of the request on a durable medium, then what
 * was decided. No medical content and no record: dates, an amount and, for a refusal, the operator's own reason.
 */
const day = (iso: string) => iso.slice(0, 10);

export function withdrawalReceivedMail(to: Recipient, requestedAt: string): MailMessage {
  const lang = recipientLanguage(to);
  return composeMail({
    to,
    subject: tm(lang, 'Your withdrawal request'),
    heading: tm(lang, 'Your withdrawal request'),
    intro: [tm(lang, 'We received your request to withdraw from your purchase on {date}.', { date: day(requestedAt) }), tm(lang, 'We will answer within 14 days. If it is accepted we end your plan and refund what is due, to the way you paid.')],
    action: { label: tm(lang, 'Open Spine'), url: publicUrl('/account') },
    outro: [tm(lang, 'This message is the confirmation of your request; keep it.')],
  });
}

export function withdrawalAcceptedMail(to: Recipient, refunded: string): MailMessage {
  const lang = recipientLanguage(to);
  return composeMail({
    to,
    subject: tm(lang, 'Your withdrawal was accepted'),
    heading: tm(lang, 'Your withdrawal was accepted'),
    intro: [tm(lang, 'We accepted your withdrawal. Your plan has ended, and we refunded {amount} to the way you paid; it can take a few days to show.', { amount: refunded })],
    action: { label: tm(lang, 'Open Spine'), url: publicUrl('/account') },
    outro: [tm(lang, 'Your records stay, and you can export them.')],
  });
}

export function withdrawalDeclinedMail(to: Recipient, reason: string | null): MailMessage {
  const lang = recipientLanguage(to);
  return composeMail({
    to,
    subject: tm(lang, 'About your withdrawal request'),
    heading: tm(lang, 'About your withdrawal request'),
    intro: [tm(lang, 'We cannot accept your withdrawal request.'), ...(reason ? [tm(lang, 'Reason: {reason}', { reason })] : [])],
    action: { label: tm(lang, 'Open Spine'), url: publicUrl('/account') },
    outro: [tm(lang, 'If you think this is wrong, write to us and say the address of your account.')],
  });
}
