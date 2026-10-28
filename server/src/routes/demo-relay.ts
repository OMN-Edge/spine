import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { demoUploads } from '../config.js';
import { issueToken } from '../relay/token.js';
import { relayEnv, relaySettings } from './relay.js';

/** As long as an account's pass: a reading finishes inside it, and the demo's core asks again. */
const PASS_MS = 10 * 60 * 1000;

export interface DemoRelayRouteOptions {
  /** Passes one address may be given a minute (tests set it). */
  tokenPerSource?: { max: number; timeWindow: string };
}

/**
 * The demo's uploads (SECURITY.md M-39): what a visitor's browser, with no account, is told and given so it can read a few files of its
 * own. Both routes are public and answer 404 unless the operator set `SPINE_DEMO_UPLOADS=on` and the instance has a relay.
 *
 * The pass is for `demo:<address>`, the address kept as a keyed hash so the relay learns no IP, and the relay counts the calls of each
 * address and of all of them together for the day. That count is the bound: the upload limits in the settings run in the visitor's browser.
 */
export async function demoRelayRoutes(app: FastifyInstance, opts: DemoRelayRouteOptions = {}) {
  const available = () => {
    const limits = demoUploads();
    const settings = relaySettings();
    return limits && settings ? { limits, settings } : null;
  };

  app.get('/api/demo-relay/config', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (_req, reply) => {
    const on = available();
    if (!on) return reply.status(404).send({ error: 'the demo does not read files on this instance', code: 'demo_off' });
    // What the demo calls a model for is reading uploads, nothing else: no questions, translations, links or vectors to pay for.
    const env = relayEnv(on.settings);
    for (const name of Object.keys(env)) if (name.startsWith('SPINE_EMBEDDING')) delete env[name];
    Object.assign(env, {
      SPINE_CHAT: 'off', SPINE_TRANSLATION: 'off', SPINE_LINKING: 'off',
      SPINE_DEMO_MAX_UPLOADS: String(on.limits.uploads), SPINE_DEMO_MAX_PAGES: String(on.limits.pages),
    });
    return reply.header('Cache-Control', 'no-store').send({ env, limits: on.limits });
  });

  app.post('/api/demo-relay/token', { config: { rateLimit: opts.tokenPerSource ?? { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const on = available();
    if (!on) return reply.status(404).send({ error: 'the demo does not read files on this instance', code: 'demo_off' });
    const address = createHmac('sha256', on.settings.secret).update(`demo-address:${req.ip ?? ''}`).digest('base64url').slice(0, 22);
    const { token, expiresAt } = issueToken(on.settings.secret, `demo:${address}`, PASS_MS);
    return reply.header('Cache-Control', 'no-store').send({ token, expires_at: expiresAt });
  });
}
