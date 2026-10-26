import type { FastifyInstance } from 'fastify';
import { requireAuth } from 'spine-core/routes/middleware.js';
import { getMailer } from '../mail/index.js';
import { issueToken, MIN_SECRET_LENGTH } from '../relay/token.js';

/** How long a pass to the relay lasts: long enough for a reading to finish, short enough that a stolen one is nearly useless. */
const PASS_MS = 10 * 60 * 1000;

/**
 * Settings the device takes from the server: how the model calls are made, which features are on, and where the relay is. Only these
 * names, copied if set. Nothing secret is on the list, and `SPINE_LLM_PROVIDER` and the endpoints are set by `relayEnv`.
 */
const SHARED = [
  'SPINE_LLM_MODEL', 'SPINE_LLM_MODELS', 'SPINE_LLM_CONTEXT_CHARS', 'SPINE_LLM_CONCURRENCY',
  'SPINE_LLM_MAX_RETRIES', 'SPINE_LLM_MAX_TOKENS_CONTINUATION', 'SPINE_LLM_MAX_TOKENS_EXTRACTION', 'SPINE_LLM_MAX_TOKENS_PAGE',
  'SPINE_TRANSLATION', 'SPINE_CHAT', 'SPINE_LINKING', 'SPINE_LLM_DAILY_CALLS',
  'SPINE_PARSER', 'SPINE_MULTIMODAL_ENABLED', 'SPINE_OCR', 'SPINE_TEXT_LAYER_MIN_CHARS', 'SPINE_OCR_MIN_CONFIDENCE',
  'SPINE_OCR_MAX_LOW_SHARE', 'SPINE_OCR_LANGS',
  'SPINE_EMBEDDING_MODEL', 'SPINE_EMBEDDING_DIMS',
] as const;

export interface RelaySettings { url: string; secret: string }

/** `SPINE_RELAY_URL` and `SPINE_RELAY_SECRET` together, or null when this instance has no relay (a device then cannot call a model). */
export function relaySettings(env: NodeJS.ProcessEnv = process.env): RelaySettings | null {
  const url = (env.SPINE_RELAY_URL ?? '').trim().replace(/\/+$/, '');
  const secret = env.SPINE_RELAY_SECRET ?? '';
  if (!url || secret.length < MIN_SECRET_LENGTH) return null;
  if (!/^https:\/\/[^/\s]+$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) return null;
  return { url, secret };
}

export function relayEnv(settings: RelaySettings, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const host = new URL(settings.url).host;
  const out: Record<string, string> = {};
  for (const name of SHARED) if (env[name] !== undefined && env[name] !== '') out[name] = env[name]!;
  // The device speaks the relay's neutral protocol; which provider answers is the relay's own configuration, not this server's.
  out.SPINE_LLM_PROVIDER = 'relay';
  out.SPINE_LLM_ENDPOINT = host;
  const embedder = (env.SPINE_EMBEDDINGS ?? 'none').toLowerCase();
  if (embedder !== 'none') {
    out.SPINE_EMBEDDINGS = 'relay';
    out.SPINE_EMBEDDING_ENDPOINT = host;
    // Vectors keep the name they had when this server made them itself.
    out.SPINE_EMBEDDING_SPACE = `${embedder}:${env.SPINE_EMBEDDING_MODEL || 'gemini-embedding-2'}:${env.SPINE_EMBEDDING_DIMS || '768'}`;
  }
  return out;
}

export async function relayRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/relay/config', async (_req, reply) => {
    const settings = relaySettings();
    if (!settings) return reply.status(503).send({ error: 'this instance has no relay for model calls', code: 'no_relay' });
    return reply.header('Cache-Control', 'no-store').send({ url: settings.url, env: relayEnv(settings), mail: getMailer().enabled });
  });

  app.get('/api/relay/token', async (req, reply) => {
    const settings = relaySettings();
    if (!settings) return reply.status(503).send({ error: 'this instance has no relay for model calls', code: 'no_relay' });
    const { token, expiresAt } = issueToken(settings.secret, req.userId, PASS_MS);
    return reply.header('Cache-Control', 'no-store').send({ token, expires_at: expiresAt });
  });
}
