import type { FastifyInstance } from 'fastify';
import { requireAuth } from './middleware.js';
import { loadEmbeddingConfig, loadLlmConfig } from '../config.js';
import { getMailer } from '../mail/index.js';
import { issueToken, MIN_SECRET_LENGTH } from '../relay/token.js';

/** How long a pass to the relay lasts: long enough for a reading to finish, short enough that a stolen one is nearly useless. */
const PASS_MS = 10 * 60 * 1000;

/**
 * Settings the device takes from the server: how the model calls are made, which features are on, and where the relay is. Only these
 * names, copied if set. Nothing secret is on the list, and `SPINE_LLM_PROVIDER` and the endpoints are set by `relayEnv`.
 */
const SHARED = [
  'SPINE_LLM_MODEL', 'SPINE_LLM_MODELS', 'SPINE_LLM_REGION', 'SPINE_LLM_PROJECT', 'SPINE_LLM_CONTEXT_CHARS', 'SPINE_LLM_CONCURRENCY',
  'SPINE_LLM_MAX_RETRIES', 'SPINE_LLM_MAX_TOKENS_CONTINUATION', 'SPINE_LLM_MAX_TOKENS_EXTRACTION', 'SPINE_LLM_MAX_TOKENS_PAGE',
  'SPINE_TRANSLATION', 'SPINE_CHAT', 'SPINE_LINKING',
  'SPINE_PARSER', 'SPINE_MULTIMODAL_ENABLED', 'SPINE_OCR', 'SPINE_TEXT_LAYER_MIN_CHARS', 'SPINE_OCR_MIN_CONFIDENCE',
  'SPINE_OCR_MAX_LOW_SHARE', 'SPINE_OCR_LANGS',
  'SPINE_EMBEDDINGS', 'SPINE_EMBEDDING_MODEL', 'SPINE_EMBEDDING_DIMS', 'SPINE_EMBEDDING_REGION', 'SPINE_EMBEDDING_PROJECT',
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
  // The device speaks to Vertex, and to the relay as if it were the regional host: the relay forwards to the real one.
  out.SPINE_LLM_PROVIDER = 'vertex';
  out.SPINE_LLM_ENDPOINT = host;
  if ((env.SPINE_EMBEDDINGS ?? 'none') === 'vertex') out.SPINE_EMBEDDING_ENDPOINT = host;
  // A model with a region of its own is called at the relay too; its host is the relay's, the region stays in the path.
  return out;
}

export async function relayRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/relay/config', async (_req, reply) => {
    const settings = relaySettings();
    if (!settings) return reply.status(503).send({ error: 'this instance has no relay for model calls', code: 'no_relay' });
    // Refused here rather than failing on the device: the relay forwards to Vertex only.
    if (loadLlmConfig().provider !== 'vertex') return reply.status(503).send({ error: 'model calls from a device need SPINE_LLM_PROVIDER=vertex', code: 'no_relay' });
    void loadEmbeddingConfig();
    return reply.header('Cache-Control', 'no-store').send({ url: settings.url, env: relayEnv(settings), mail: getMailer().enabled });
  });

  app.get('/api/relay/token', async (req, reply) => {
    const settings = relaySettings();
    if (!settings) return reply.status(503).send({ error: 'this instance has no relay for model calls', code: 'no_relay' });
    const { token, expiresAt } = issueToken(settings.secret, req.userId, PASS_MS);
    return reply.header('Cache-Control', 'no-store').send({ token, expires_at: expiresAt });
  });
}
