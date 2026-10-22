import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../config.js';

/**
 * P3 / S-3: `index.ts` read
 * `process.env.SESSION_SECRET ?? 'dev-secret-change-in-production-must-be-32-chars'`,
 * so an unset or mistyped variable signed cookies with a value published in
 * this repository. The service must refuse to start instead.
 */

const valid = {
  SESSION_SECRET: 'a'.repeat(32),
  PORT: '3000',
};

describe('loadConfig — secrets (P3, S-3)', () => {
  it('accepts a complete configuration', () => {
    const config = loadConfig({ ...valid });
    expect(config.sessionSecret).toBe('a'.repeat(32));
    expect(config.port).toBe(3000);
  });

  it('throws when SESSION_SECRET is unset', () => {
    expect(() => loadConfig({ ...valid, SESSION_SECRET: undefined })).toThrow(ConfigError);
  });

  it('throws when SESSION_SECRET is shorter than 32 chars', () => {
    expect(() => loadConfig({ ...valid, SESSION_SECRET: 'a'.repeat(31) })).toThrow(/at least 32/);
  });

  it('throws on the secret this repository used to fall back to', () => {
    expect(() =>
      loadConfig({ ...valid, SESSION_SECRET: 'dev-secret-change-in-production-must-be-32-chars' }),
    ).toThrow(/published in this repository/);
  });

  it('throws on the placeholder from .env.example', () => {
    expect(() =>
      loadConfig({ ...valid, SESSION_SECRET: 'change-this-to-a-random-64-char-string' }),
    ).toThrow(ConfigError);
  });

  it('reports every problem at once', () => {
    try {
      loadConfig({ PORT: 'http' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('SESSION_SECRET is not set');
      expect((err as Error).message).toContain('PORT');
    }
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => loadConfig({ ...valid, PORT: 'http' })).toThrow(/PORT/);
  });
});

describe('loadConfig — bind address', () => {
  it('binds loopback by default, so nginx is the only public listener', () => {
    expect(loadConfig({ ...valid }).host).toBe('127.0.0.1');
  });

  it('allows an explicit override for hosts that need one', () => {
    expect(loadConfig({ ...valid, SPINE_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
  });
});

describe('landingUrl', () => {
  it('is an https address or nothing', async () => {
    const { landingUrl } = await import('../config.js');
    expect(landingUrl({})).toBeNull();
    expect(landingUrl({ SPINE_LANDING_URL: 'https://spine.example.com' })).toBe('https://spine.example.com/');
    for (const bad of ['http://spine.example.com', 'javascript:alert(1)', 'not a url', '  ']) expect(landingUrl({ SPINE_LANDING_URL: bad })).toBeNull();
  });
});

describe('trustedProxies', () => {
  it('is loopback, plus an address named for a proxy elsewhere', async () => {
    const { trustedProxies } = await import('../trust-proxy.js');
    expect(trustedProxies({})).toEqual(['127.0.0.1', '::1']);
    expect(trustedProxies({ SPINE_TRUSTED_PROXIES: '172.30.0.10, 10.0.0.0/24' })).toEqual(['127.0.0.1', '::1', '172.30.0.10', '10.0.0.0/24']);
  });
  it('refuses a range that would trust the world, and anything that is not an address', async () => {
    const { trustedProxies } = await import('../trust-proxy.js');
    for (const bad of ['true', '*', '0.0.0.0/0', '::/0', '10.0.0.0/7', '1.2.3.4/33', 'proxy.local', '1.2.3.4/x']) {
      expect(() => trustedProxies({ SPINE_TRUSTED_PROXIES: bad })).toThrow(/SPINE_TRUSTED_PROXIES/);
    }
  });
});
