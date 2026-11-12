import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { useSettings } from 'spine-core/config.js';
import { securityContact, securityTxtRoutes } from '../routes/security-txt.js';

describe('/.well-known/security.txt', () => {
  const before = process.env.SPINE_OPERATOR_CONTACT;
  afterEach(() => { if (before === undefined) delete process.env.SPINE_OPERATOR_CONTACT; else process.env.SPINE_OPERATOR_CONTACT = before; });

  async function get() {
    useSettings({ ...process.env, SPINE_DOMAIN: 'spine.example.org' } as never);
    const app = Fastify();
    await app.register(securityTxtRoutes);
    const res = await app.inject({ url: '/.well-known/security.txt' });
    await app.close();
    return res;
  }

  it("names the operator's contact, this instance's own address and a year's expiry, as plain text", async () => {
    process.env.SPINE_OPERATOR_CONTACT = 'privacy@operator.example';
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('Contact: mailto:privacy@operator.example\n');
    expect(res.body).toContain('Canonical: https://spine.example.org/.well-known/security.txt\n');
    const expires = /^Expires: (.+)$/m.exec(res.body)![1];
    const days = (Date.parse(expires) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(360);
    expect(days).toBeLessThan(366);
  });

  it("never names the project's address, and is a 404 with no contact set", async () => {
    process.env.SPINE_OPERATOR_CONTACT = 'privacy@operator.example';
    expect((await get()).body).not.toMatch(/spinevault|cocinda/);
    delete process.env.SPINE_OPERATOR_CONTACT;
    expect((await get()).statusCode).toBe(404);
  });

  it('takes an address or a link, and nothing else', () => {
    expect(securityContact('a@b.example')).toBe('mailto:a@b.example');
    expect(securityContact(' mailto:a@b.example ')).toBe('mailto:a@b.example');
    expect(securityContact('https://b.example/report')).toBe('https://b.example/report');
    expect(securityContact('the operator of this instance')).toBeNull();
    expect(securityContact('a@b.example\nContact: x@y.example')).toBeNull();
    expect(securityContact('')).toBeNull();
    expect(securityContact(undefined)).toBeNull();
  });
});
