import { publicUrl } from 'spine-core/config.js';
import type { InterfaceLanguage } from 'spine-core/languages.js';
import { tm, recipientEmail, recipientLanguage, type Recipient } from './i18n.js';
import type { MailMessage } from './types.js';

/**
 * What an account message says, once: `composeMail` makes the plain-text part and the HTML part from it, so the two cannot drift.
 * Nothing here carries medical content (SECURITY.md P8); the layout is the public pages' own paper, ink and teal (web/tailwind.config.js).
 *
 * The HTML is written for mail clients, not browsers: tables, inline styles, no script, no web font and no image but the mark (below). The dark theme is a `prefers-color-scheme` block for the clients that honour it; the others show the light one.
 */
export interface MailContent {
  /** Who it is for; the account's language, if the mail is written in it, is the message's (i18n.ts). Every string below is already in it. */
  to: Recipient;
  subject: string;
  /** The line an inbox shows beside the subject; hidden in the message itself. */
  preheader?: string;
  heading: string;
  /** Paragraphs before the button, one string each. */
  intro: string[];
  /** The one thing to do. The URL is also printed under the button, for a client that does not show buttons. */
  action?: { label: string; url: string };
  /** Facts about what happened (when, from where), shown as a quiet list. */
  details?: Array<[label: string, value: string]>;
  /** Paragraphs after the button: what to do if it was not the reader, how long a link lasts. */
  outro?: string[];
}

const PAPER = '#f5f7f6';
const INK = '#17292a';
const MUTED = '#4f6061';
const ACCENT = '#0f766e';
const LINE = '#dbe4e2';

const SERIF = "Literata, Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The mark is the real logo (web/public/favicon.svg), as two small PNGs on this site's own origin, one in each theme's teal: a mail client
 * strips inline SVG, so a picture is the only way to show it. Opening a message therefore asks this server for them, which it can see in its
 * own log and nobody else can (a mail client that proxies images, as Gmail does, asks once and hides the reader's address).
 * The dark one is shown only where `prefers-color-scheme` is honoured.
 */
const markImg = (file: string, extra: string, cls: string) =>
  `<img class="${cls}" src="${escapeHtml(publicUrl(`/icons/${file}`))}" width="28" height="28" alt="" style="${extra || 'display:block;'}border:0;width:28px;height:28px;">`;
// A function, not a constant: the address comes from the settings, which a process registers after its modules load (the CLI starts that way).
const mark = () => markImg('mail-mark.png', '', 'mk-l') + markImg('mail-mark-dark.png', 'display:none;max-height:0;overflow:hidden;mso-hide:all;', 'mk-d');

const STYLE = `
  body { margin:0; padding:0; background:${PAPER}; }
  a { color:${ACCENT}; }
  @media (prefers-color-scheme: dark) {
    .bg { background:#101819 !important; }
    .card { background:#182324 !important; border-color:#2a3b3c !important; }
    .ink { color:#eaf1f0 !important; }
    .muted { color:#a9bbba !important; }
    .rule { border-color:#2a3b3c !important; }
    .mk-l { display:none !important; }
    .mk-d { display:block !important; max-height:none !important; }
    .btn { background:#6fd3c4 !important; }
    .btn a { color:#0c1415 !important; }
    a.link { color:#6fd3c4 !important; }
  }
`;

function paragraph(text: string): string {
  return `<p class="ink" style="margin:0 0 16px;font:400 16px/1.6 ${SANS};color:${INK};">${escapeHtml(text)}</p>`;
}

export function renderHtml(c: MailContent, lang: InterfaceLanguage = recipientLanguage(c.to)): string {
  const details = c.details?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="rule" style="margin:4px 0 20px;border-top:1px solid ${LINE};">${c.details
        .map(
          ([label, value]) =>
            `<tr><td class="muted rule" style="padding:10px 0;border-bottom:1px solid ${LINE};font:400 14px/1.4 ${SANS};color:${MUTED};width:38%;">${escapeHtml(label)}</td>` +
            `<td class="ink rule" style="padding:10px 0;border-bottom:1px solid ${LINE};font:500 14px/1.4 ${SANS};color:${INK};">${escapeHtml(value)}</td></tr>`,
        )
        .join('')}</table>`
    : '';
  const action = c.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 12px;"><tr>` +
      `<td class="btn" style="border-radius:999px;background:${ACCENT};">` +
      `<a href="${escapeHtml(c.action.url)}" style="display:inline-block;padding:13px 26px;font:500 16px/1 ${SANS};color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(c.action.label)}</a>` +
      `</td></tr></table>` +
      `<p class="muted" style="margin:0 0 24px;font:400 13px/1.5 ${SANS};color:${MUTED};word-break:break-all;">${escapeHtml(tm(lang, 'Or paste this address into your browser:'))}<br><a class="link" href="${escapeHtml(c.action.url)}" style="color:${ACCENT};">${escapeHtml(c.action.url)}</a></p>`
    : '';
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(c.subject)}</title><style>${STYLE}</style></head>
<body class="bg" style="margin:0;padding:0;background:${PAPER};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(c.preheader ?? c.intro[0] ?? '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg" style="background:${PAPER};"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
<tr><td style="padding:0 4px 20px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td valign="middle" style="padding-right:10px;">${mark()}</td>
<td valign="middle" class="ink" style="font:600 20px/1 ${SANS};letter-spacing:-0.01em;color:${INK};">Spine</td></tr></table></td></tr>
<tr><td class="card" style="background:#ffffff;border:1px solid ${LINE};border-radius:12px;border-top:3px solid ${ACCENT};padding:32px 28px;">
<h1 class="ink" style="margin:0 0 18px;font:600 24px/1.25 ${SERIF};letter-spacing:-0.01em;color:${INK};">${escapeHtml(c.heading)}</h1>
${c.intro.map(paragraph).join('\n')}${details}${action}${(c.outro ?? []).map(paragraph).join('\n')}
</td></tr>
<tr><td class="muted" style="padding:20px 8px 0;font:400 12px/1.6 ${SANS};color:${MUTED};text-align:center;">${escapeHtml(tm(lang, 'You are getting this because of something that happened to your Spine account.'))}<br>${escapeHtml(tm(lang, 'Spine never puts what is in your records in an email.'))}</td></tr>
</table></td></tr></table>
</body></html>`;
}

/** The plain-text part: the same words in order, the link on a line of its own so a client makes it tappable. */
export function renderText(c: MailContent): string {
  const parts = [...c.intro];
  if (c.details?.length) parts.push(c.details.map(([k, v]) => `${k}: ${v}`).join('\n'));
  if (c.action) parts.push(c.action.url);
  parts.push(...(c.outro ?? []));
  return `${parts.join('\n\n')}\n`;
}

export function composeMail(c: MailContent): MailMessage {
  return { to: recipientEmail(c.to), subject: c.subject, text: renderText(c), html: renderHtml(c) };
}
