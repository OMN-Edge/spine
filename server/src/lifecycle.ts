import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AccountsStore, UserRecord } from 'spine-core/store/types.js';
import { trialEnd } from 'spine-core/billing/plans.js';
import { publicUrl } from 'spine-core/config.js';
import { logger } from 'spine-core/logger.js';
import { composeMail } from './mail/layout.js';
import { getMailer, type MailMessage } from './mail/index.js';
import { recipientLanguage, tm, type Recipient } from './mail/i18n.js';
import { standingOf } from './billing/seat.js';
import { billingOn } from './billing/config.js';
import { settingOf } from './operator-settings.js';

/**
 * The mail Spine sends on its own about using it (the marketing plan's "Automatic emails"): a welcome with the first step, a reminder now and then to add the
 * documents of an appointment, and, two weeks before a trial ends, what the account has done and the plan that fits. **No medical content in any of them**: no
 * document, value, question or name, only counts the relay keeps (pages read, questions asked, pages translated). Each is sent once per account and kind, and
 * the reminder at the interval the operator sets (the admin page's setting, else `SPINE_NUDGE_DAYS`; none unless set); the reminder and the trial's mail carry a link that stops them,
 * and an account that used it gets neither again. What was sent is a counter under the account, never a copy of the mail.
 */
const OPT_OUT = 'mail:optout';
const WELCOME = 'mail:welcome';
const TRIAL = 'mail:trial';
const NUDGE_AT = 'mail:nudge:at';
const DAY_MS = 24 * 3600e3;
/** How long before the trial ends its mail is sent. */
export const TRIAL_MAIL_DAYS = 14;

const secret = () => process.env.SESSION_SECRET ?? '';
const mac = (userId: string) => createHmac('sha256', secret()).update(`unsubscribe\0${userId}`, 'utf8').digest('hex').slice(0, 32);
/** What the link that stops these mails carries: the account and a signature only this server can make. It is in the address's fragment, so it never reaches a log. */
export const unsubscribeToken = (userId: string): string => `${userId}.${mac(userId)}`;
export function userOfUnsubscribeToken(token: unknown): string | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const userId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'utf8');
  const expected = Buffer.from(mac(userId), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected) ? userId : null;
}
const unsubscribeLink = (userId: string) => publicUrl(`/unsubscribe#${unsubscribeToken(userId)}`);

export function welcomeMail(to: Recipient): MailMessage {
  const lang = recipientLanguage(to);
  return composeMail({
    to,
    subject: tm(lang, 'Welcome to Spine'),
    heading: tm(lang, 'Welcome to Spine'),
    intro: [tm(lang, 'Your account is ready.'), tm(lang, 'The first step is to add the documents you already have. Spine reads them, sorts them and puts them on a timeline.')],
    action: { label: tm(lang, 'Add your documents'), url: publicUrl('/upload') },
    outro: [tm(lang, 'Spine never puts what is in your records in an email.')],
  });
}

export function nudgeMail(to: Recipient, userId: string): MailMessage {
  const lang = recipientLanguage(to);
  return composeMail({
    to,
    subject: tm(lang, 'Had an appointment lately?'),
    heading: tm(lang, 'Had an appointment lately?'),
    intro: [tm(lang, 'If you did, add its documents now, while you remember what they are for.')],
    action: { label: tm(lang, 'Add documents'), url: publicUrl('/upload') },
    outro: [tm(lang, 'You get this reminder now and then. To stop it, open this address:'), unsubscribeLink(userId)],
  });
}

export interface TrialSummary { endsOn: string; pages: number; questions: number; translated: number; fits: 'free' | 'essential' | 'premium' }
/** The plan that fits what was done: translation is Premium's, questions are Essential's, and keeping and showing is the free plan's. */
export const planThatFits = (s: Pick<TrialSummary, 'questions' | 'translated'>): TrialSummary['fits'] => (s.translated > 0 ? 'premium' : s.questions > 0 ? 'essential' : 'free');

export function trialEndsMail(to: Recipient, userId: string, s: TrialSummary): MailMessage {
  const lang = recipientLanguage(to);
  const fits = s.fits === 'premium' ? tm(lang, 'The plan that fits what you did is Premium.') : s.fits === 'essential' ? tm(lang, 'The plan that fits what you did is Essential.') : tm(lang, 'What you did fits the free plan, which you keep.');
  return composeMail({
    to,
    subject: tm(lang, 'Your Spine trial ends in two weeks'),
    heading: tm(lang, 'Your Spine trial ends in two weeks'),
    intro: [tm(lang, 'Your trial ends on {date}. Your archive stays visible and you can export it; after that only adding more and asking are held back.', { date: s.endsOn }), fits],
    details: [[tm(lang, 'Pages read'), String(s.pages)], [tm(lang, 'Questions asked'), String(s.questions)], [tm(lang, 'Pages translated'), String(s.translated)]],
    action: { label: tm(lang, 'See the plans'), url: publicUrl('/account') },
    outro: [tm(lang, 'To stop messages like this one, open this address:'), unsubscribeLink(userId)],
  });
}

/** Counted the first time only: true for the call that claimed it. */
const claim = async (store: AccountsStore, userId: string, key: string): Promise<boolean> => (await store.usage.aiAdd(userId, key, 1)) === 1;
const optedOut = async (store: AccountsStore, userId: string): Promise<boolean> => (await store.usage.aiUsed(userId, OPT_OUT)) > 0;

/** An account that used the link in a mail gets no more of the reminders and the trial's. Said once. */
export async function stopLifecycleMail(store: AccountsStore, userId: string): Promise<boolean> {
  if (!(await store.users.findById(userId))) return false;
  if ((await store.usage.aiUsed(userId, OPT_OUT)) === 0) await store.usage.aiAdd(userId, OPT_OUT, 1);
  return true;
}

const reachable = (u: Pick<UserRecord, 'email_verified_at' | 'approved'>) => !!u.email_verified_at && u.approved !== 0;

/** The welcome, sent when the address is confirmed. A mail that cannot be sent is the mailer's to say; it never fails the confirmation. */
export async function sendWelcome(store: AccountsStore, userId: string): Promise<boolean> {
  const mailer = getMailer();
  if (!mailer.enabled) return false;
  const user = await store.users.findById(userId);
  if (!user || !reachable(user) || !(await claim(store, userId, WELCOME))) return false;
  await mailer.send(welcomeMail({ email: user.email, language: user.language }));
  return true;
}


/** The reminders that are due and the trial mails that are due; safe to run more than once at the same time (each is claimed in the database). Answers how many were sent. */
export async function sendLifecycleMail(store: AccountsStore, now: Date = new Date()): Promise<number> {
  const mailer = getMailer();
  if (!mailer.enabled) return 0;
  const every = (await settingOf(store, 'mail.nudge_days')) ?? 0;
  // Only whether plans are on: the job that runs this has no settings of the payment provider (it never calls it), as the relay has none.
  const billing = billingOn();
  if (every === 0 && !billing) return 0;
  let sent = 0;
  for (const row of await store.users.list()) {
    try {
      if (!reachable(row) || (await optedOut(store, row.id))) continue;
      const user = await store.users.findById(row.id);
      if (!user) continue;
      const to = { email: user.email, language: user.language };

      // Two weeks before the trial ends, once: what was done, and the plan that fits.
      if (billing) {
        const standing = await standingOf(store, user.id, now);
        const end = Date.parse(trialEnd(user.created_at));
        if (standing?.entitlements.plan === 'trial' && end - now.getTime() <= TRIAL_MAIL_DAYS * DAY_MS && (await claim(store, user.id, TRIAL))) {
          const [pages, questions, translated] = await Promise.all(['total:pages', 'total:messages', 'total:translated'].map(k => store.usage.aiUsed(user.id, k)));
          const summary = { endsOn: new Date(end).toISOString().slice(0, 10), pages: pages!, questions: questions!, translated: translated!, fits: 'free' as const };
          await mailer.send(trialEndsMail(to, user.id, { ...summary, fits: planThatFits(summary) }));
          sent++;
          continue;
        }
      }

      // The reminder, at most once in the interval the operator set, counted from the last one or the day the account was made.
      if (every > 0) {
        const lastDay = await store.usage.aiUsed(user.id, NUDGE_AT);
        const today = Math.floor(now.getTime() / DAY_MS);
        const since = lastDay > 0 ? lastDay : Math.floor(Date.parse(user.created_at) / DAY_MS);
        if (today - since >= every && (await markNudge(store, user.id, lastDay, today))) {
          await mailer.send(nudgeMail(to, user.id));
          sent++;
        }
      }
    } catch (err) {
      logger.warn('a lifecycle mail could not be sent', { reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return sent;
}

/** Moves the day of the last reminder forward (a counter only grows), answering whether this call is the one that did. Two runs at once cannot both. */
async function markNudge(store: AccountsStore, userId: string, from: number, to: number): Promise<boolean> {
  const after = await store.usage.aiAdd(userId, NUDGE_AT, to - from);
  return after === to;
}
