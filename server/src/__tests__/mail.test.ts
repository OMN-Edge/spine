import { describe, it, expect, vi } from 'vitest';
import { createMailer, MAILERS } from '../mail/index.js';
import { parseSender } from '../mail/adapters/brevo.js';
import { MailerConfigError, MailerDisabledError } from '../mail/types.js';
import { loadConfig, loadMailConfig, loadRegistrationMode, publicUrl, ConfigError } from '../config.js';
import { resetMail, verificationMail } from '../accounts.js';

describe('createMailer — the registry', () => {
  it('lists the adapters that exist', () => {
    expect(MAILERS.sort()).toEqual(['brevo', 'none']);
  });

  it('names the valid set when the adapter is unknown', () => {
    expect(() => createMailer({ adapter: 'sendgrid' })).toThrow(/expected one of brevo, none/);
  });
});

describe('the none adapter', () => {
  it('reports itself disabled and refuses to send', async () => {
    const mailer = createMailer({ adapter: 'none' });
    expect(mailer.enabled).toBe(false);
    await expect(mailer.send({ to: 'a@b.co', subject: 's', text: 't' })).rejects.toBeInstanceOf(MailerDisabledError);
  });
});

describe('the brevo adapter', () => {
  const ok = () => vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
  const config = (fetchImpl: typeof fetch) => ({
    adapter: 'brevo', apiKey: 'xkeysib-test', sender: 'Notices <notices@example.com>', fetchImpl,
  });

  it('posts one request to Brevo with the key in a header, not the body', async () => {
    const fetchImpl = ok();
    await createMailer(config(fetchImpl)).send({ to: 'user@example.com', subject: 'Hello', text: 'Body' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.headers['api-key']).toBe('xkeysib-test');
    expect(init.body).not.toContain('xkeysib-test');
    expect(JSON.parse(init.body)).toEqual({
      sender: { name: 'Notices', email: 'notices@example.com' },
      to: [{ email: 'user@example.com' }],
      subject: 'Hello',
      textContent: 'Body',
    });
  });

  it('has no way to attach anything', async () => {
    const fetchImpl = ok();
    // A message cannot carry an attachment: the type has no such field, and the
    // request is built only from the fields it does have.
    await createMailer(config(fetchImpl)).send({
      to: 'a@b.co', subject: 's', text: 't',
      ...({ attachment: [{ name: 'scan.pdf', content: 'x' }] } as object),
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(Object.keys(body).sort()).toEqual(['sender', 'subject', 'textContent', 'to']);
  });

  it('rejects on a non-2xx, naming the status but never the message or recipient', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('{"message":"invalid recipient secret@example.com"}', { status: 400 }),
    );
    const failure = createMailer(config(fetchImpl)).send({
      to: 'secret@example.com', subject: 's', text: 'https://x/reset#live-token',
    });

    await expect(failure).rejects.toThrow('status 400');
    await expect(failure).rejects.not.toThrow(/secret@example\.com|live-token/);
  });

  it('does not retry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    await createMailer(config(fetchImpl)).send({ to: 'a@b.co', subject: 's', text: 't' }).catch(() => {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses to construct without a key or a sender', () => {
    expect(() => createMailer({ adapter: 'brevo', sender: 'a@b.co' })).toThrow(/BREVO_API_KEY/);
    expect(() => createMailer({ adapter: 'brevo', apiKey: 'k' })).toThrow(/SPINE_MAIL_SENDER/);
  });
});

describe('parseSender', () => {
  it('reads both forms', () => {
    expect(parseSender('Notices <n@example.com>')).toEqual({ name: 'Notices', email: 'n@example.com' });
    expect(parseSender('"Account Notice" <n@example.com>')).toEqual({ name: 'Account Notice', email: 'n@example.com' });
    expect(parseSender('n@example.com')).toEqual({ email: 'n@example.com' });
  });

  it('rejects something that is not an address', () => {
    expect(() => parseSender('not an address')).toThrow(MailerConfigError);
  });
});

/** P3: open signup verifies addresses by mail, so it cannot start without a mailer. */
describe('registration and mailer configuration', () => {
  const base = { SESSION_SECRET: 'a'.repeat(32) };

  it('defaults to operator registration and no mailer, which boots', () => {
    const config = loadConfig({ ...base });
    expect(config.registration).toBe('operator');
    expect(config.mail.adapter).toBe('none');
  });

  it('refuses open registration with no mailer', () => {
    expect(() => loadConfig({ ...base, SPINE_REGISTRATION: 'open' })).toThrow(
      /SPINE_REGISTRATION=open needs a mailer/,
    );
  });

  it('accepts open registration with brevo fully configured', () => {
    const config = loadConfig({
      ...base, SPINE_REGISTRATION: 'open', SPINE_MAILER: 'brevo',
      BREVO_API_KEY: 'k', SPINE_MAIL_SENDER: 'Notices <n@example.com>', SPINE_DOMAIN: 'spine.example.com',
    });
    expect(config.registration).toBe('open');
    expect(config.mail).toMatchObject({ adapter: 'brevo', apiKey: 'k' });
  });

  it('reports each missing piece of a brevo setup', () => {
    try {
      loadConfig({ ...base, SPINE_MAILER: 'brevo' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as Error).message;
      expect(message).toContain('BREVO_API_KEY');
      expect(message).toContain('SPINE_MAIL_SENDER');
      expect(message).toContain('SPINE_DOMAIN');
    }
  });

  it('rejects an unknown registration mode', () => {
    expect(() => loadConfig({ ...base, SPINE_REGISTRATION: 'invite' })).toThrow(/SPINE_REGISTRATION/);
  });

  it('reads the mail and registration sections without the session secret', () => {
    expect(loadMailConfig({}).adapter).toBe('none');
    expect(loadRegistrationMode({})).toBe('operator');
  });
});

describe('publicUrl', () => {
  it('is https for a real host and http for localhost', () => {
    expect(publicUrl('/x', { SPINE_DOMAIN: 'spine.example.com' })).toBe('https://spine.example.com/x');
    expect(publicUrl('/x', {})).toBe('http://localhost:3000/x');
    expect(publicUrl('/x', { SPINE_DOMAIN: '127.0.0.1:3000' })).toBe('http://127.0.0.1:3000/x');
  });
});

/**
 * P8: mail carries an address and a link. The wording must say nothing about what
 * this system holds — the subject is visible to the provider and to anyone who
 * sees the inbox.
 */
describe('the mail text', () => {
  const messages = [
    verificationMail('a@b.co', 'https://x.example/verify#t'),
    resetMail('a@b.co', 'https://x.example/reset#t'),
  ];

  it('mentions nothing clinical', () => {
    for (const m of messages) {
      expect(`${m.subject} ${m.text}`).not.toMatch(/medic|health|record|document|patient|clinic|doctor/i);
    }
  });

  it('carries the link and the address and nothing else of substance', () => {
    expect(messages[0].text).toContain('https://x.example/verify#t');
    expect(messages[1].text).toContain('https://x.example/reset#t');
    expect(Object.keys(messages[0]).sort()).toEqual(['subject', 'text', 'to']);
  });
});
