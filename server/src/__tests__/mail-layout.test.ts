import { publicUrl } from 'spine-core/config.js';
import { describe, expect, it } from 'vitest';
import { composeMail } from '../mail/layout.js';
import { accessRequestMail, remindersDueMail, resetMail } from '../accounts.js';
import { securityChangeMail } from '../notify.js';

describe('the mail layout', () => {
  it('puts the link in both parts, as a button and as an address, and fetches only the mark from its own origin', () => {
    const m = resetMail('a@example.org', 'https://x.example/reset#tok');
    expect(m.text).toContain('https://x.example/reset#tok');
    expect(m.html).toContain('href="https://x.example/reset#tok"');
    expect(m.html).not.toMatch(/<script|<link|url\(/i);
    const srcs = [...m.html!.matchAll(/<img[^>]*src="([^"]+)"/g)].map(x => x[1]);
    expect(srcs).toHaveLength(2);
    for (const src of srcs) expect(src).toMatch(new RegExp(`^${publicUrl('/icons/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}mail-mark(-dark)?\\.png$`));
  });

  it('escapes what a message is built from', () => {
    const m = securityChangeMail('a@example.org', 'seatTaken', '2026-01-01T00:00:00Z', { email: '<b>"x"</b>&co@example.org' });
    expect(m.html).not.toContain('<b>');
    expect(m.html).toContain('&lt;b&gt;&quot;x&quot;&lt;/b&gt;&amp;co@example.org');
    const c = composeMail({ to: 'a@example.org', subject: 's', heading: 'h', intro: ['i'], action: { label: 'go', url: 'https://x.example/?a=1&b="2"' } });
    expect(c.html).toContain('href="https://x.example/?a=1&amp;b=&quot;2&quot;"');
  });

  it('lists details and reads in order as text', () => {
    const m = accessRequestMail('a@example.org', 'https://x.example/share-requests/1', '2026-01-01T00:00:00Z', '203.0.113.9');
    expect(m.html).toContain('Requested at');
    expect(m.text.indexOf('A link you shared')).toBeLessThan(m.text.indexOf('https://x.example/share-requests/1'));
    expect(m.text).toContain('203.0.113.9');
  });

  it('has a dark scheme and a hidden preview line', () => {
    const m = remindersDueMail('a@example.org', 2);
    expect(m.html).toContain('prefers-color-scheme: dark');
    expect(m.html).toContain('2 reminders are due');
  });
});
