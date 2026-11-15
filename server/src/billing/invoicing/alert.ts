import { logger } from 'spine-core/logger.js';
import { getMailer } from '../../mail/index.js';

/**
 * Tells the operator of something about the invoices that only a person can mend: in the log, and by mail where `SPINE_ALERT_EMAIL` names an address and there is a
 * mailer (the address the fair-use alerts go to). Only references and the service's words, never a buyer. Never throws: an alert that cannot be sent is a log line.
 */
export async function alertOperator(subject: string, lines: string[]): Promise<void> {
  try {
    const to = process.env.SPINE_ALERT_EMAIL;
    const mailer = getMailer();
    if (!to || !mailer.enabled) return;
    await mailer.send({ to, subject: `Spine: ${subject}`, text: `${lines.join('\n')}\n\nNo buyer's name, address or amount is in this message. Look at /admin, or: npm run cli -- invoices` });
  } catch (err) {
    logger.warn('an alert to the operator could not be sent', { reason: err instanceof Error ? err.message : String(err) });
  }
}
