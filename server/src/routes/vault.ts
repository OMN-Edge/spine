import type { FastifyInstance } from 'fastify';
import { getStore } from '../store/index.js';
import { vaultLimits } from '../config.js';
import { hashPassword, normaliseEmail } from '../passwords.js';
import { AUTH_VALUE, DEFAULT_KDF, parseKdfParams, parseVaultKeys, pretendSalt } from '../vault-keys.js';
import { OBJECT_ID, readObject, removeObject, writeObject } from '../vault-files.js';
import { endOtherSessions } from '../sessions.js';
import { mailAfter, securityChangeMail } from '../notify.js';
import { requireAuth, requireRecentAuth, type SessionData } from './middleware.js';

/**
 * The vault (SECURITY.md M-34, docs/crypto-design.md): keys wrapped on the device, and objects sealed on the device. Nothing here can
 * read either. These routes check shapes, sizes, owners and sequence numbers; they never see a password, a key or a word of a record.
 *
 * `POST /api/auth/kdf` is public (a device needs the salt before it can sign in); the rest are the owner's.
 */
export interface VaultRouteOptions {
  kdfPerSource?: { max: number; timeWindow: string | number };
}

const KINDS = new Set(['profile', 'bundle', 'blob', 'library', 'embedding', 'log']);
const SEQ = /^\d{1,15}$/;

export async function vaultRoutes(app: FastifyInstance, opts: VaultRouteOptions = {}) {
  // Ciphertext arrives as the request body, as it is. The body limit is the largest object an account may hold.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: vaultLimits().objectBytes }, (_req, body, done) => done(null, body));

  // What a device must know before it can sign in: the salt and the Argon2id cost its master key was made with. An address with no
  // vault gets a salt made from the address and the server's secret, so the answer does not say which addresses have accounts.
  app.post<{ Body: { email?: string } }>(
    '/api/auth/kdf',
    { preHandler: [app.rateLimit({ max: 30, timeWindow: '10 minutes', ...opts.kdfPerSource })] },
    async (req, reply) => {
      const address = typeof req.body?.email === 'string' ? normaliseEmail(req.body.email) : '';
      if (!address || address.length > 254) return reply.status(400).send({ error: 'email required' });
      const user = await getStore().users.findByEmail(address);
      const keys = user ? await getStore().vault.getKeys(user.id) : null;
      if (user && !keys) return reply.send({ vault: false });
      return reply.send({
        vault: true,
        salt: keys?.kdf_salt ?? pretendSalt(address, process.env.SESSION_SECRET ?? ''),
        params: keys ? parseKdfParams(keys.kdf_params) : DEFAULT_KDF,
      });
    },
  );

  app.get('/api/vault/keys', { preHandler: requireAuth }, async (req, reply) => {
    const k = await getStore().vault.getKeys(req.userId);
    if (!k) return reply.status(404).send({ error: 'this account has no vault yet', code: 'no_vault' });
    return reply.send({
      kdf_salt: k.kdf_salt,
      kdf_params: parseKdfParams(k.kdf_params),
      wrapped_by_master: k.wrapped_by_master,
      wrapped_by_recovery: k.wrapped_by_recovery,
      public_key: k.public_key,
      wrapped_private_key: k.wrapped_private_key,
      seq: k.seq,
    });
  });

  // Making a vault for an account that has none (the operator made it, or it is from before the vault). The account's credential becomes
  // the value the device derived, so the password it had stops working: the person's master password is now the only one.
  app.put<{ Body: { auth_value?: string; keys?: unknown } }>(
    '/api/vault/keys',
    { preHandler: [requireAuth, requireRecentAuth, app.rateLimit({ max: 10, timeWindow: '10 minutes' })] },
    async (req, reply) => {
      const keys = parseVaultKeys(req.body?.keys);
      if (!keys || typeof req.body?.auth_value !== 'string' || !AUTH_VALUE.test(req.body.auth_value)) {
        return reply.status(400).send({ error: 'the keys are not in the expected form' });
      }
      const store = getStore();
      if (await store.vault.getKeys(req.userId)) return reply.status(409).send({ error: 'this account already has a vault' });
      await changeCredential(req, req.userId, req.body.auth_value, keys, false);
      req.log.info({ userId: req.userId }, 'vault created');
      return reply.send({ ok: true });
    },
  );

  // A new master password, or a new recovery kit: the same account key under new wrappings. The objects are not touched.
  app.post<{ Body: { auth_value?: string; keys?: unknown } }>(
    '/api/vault/keys/rewrap',
    { preHandler: [requireAuth, requireRecentAuth, app.rateLimit({ max: 10, timeWindow: '10 minutes' })] },
    async (req, reply) => {
      const keys = parseVaultKeys(req.body?.keys);
      const authValue = req.body?.auth_value;
      if (!keys || (authValue !== undefined && (typeof authValue !== 'string' || !AUTH_VALUE.test(authValue)))) {
        return reply.status(400).send({ error: 'the keys are not in the expected form' });
      }
      if (!(await getStore().vault.getKeys(req.userId))) return reply.status(404).send({ error: 'this account has no vault yet', code: 'no_vault' });
      await changeCredential(req, req.userId, authValue ?? null, keys, true);
      const user = await getStore().users.findById(req.userId);
      if (user) mailAfter(req, user.id, securityChangeMail(user.email, authValue ? 'Your password was changed' : 'Your recovery kit was replaced', new Date().toISOString()), 'vault change');
      req.log.info({ userId: req.userId }, 'vault keys rewrapped');
      return reply.send({ ok: true });
    },
  );

  app.get<{ Querystring: { since?: string } }>('/api/vault/objects', { preHandler: requireAuth }, async (req, reply) => {
    const since = req.query.since ?? '0';
    if (!SEQ.test(since)) return reply.status(400).send({ error: 'since must be a number' });
    const store = getStore();
    const [objects, usage, keys] = await Promise.all([store.vault.list(req.userId, Number(since)), store.vault.usage(req.userId), store.vault.getKeys(req.userId)]);
    return reply.send({ seq: keys?.seq ?? 0, usage, objects });
  });

  app.get<{ Params: { id: string } }>('/api/vault/objects/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (!OBJECT_ID.test(req.params.id)) return reply.status(404).send({ error: 'not found' });
    const meta = await getStore().vault.get(req.userId, req.params.id);
    const bytes = meta && !meta.deleted ? readObject(req.userId, req.params.id) : null;
    if (!meta || !bytes) return reply.status(404).send({ error: 'not found' });
    return reply
      .header('content-type', 'application/octet-stream')
      .header('cache-control', 'no-store')
      .header('x-spine-seq', String(meta.seq))
      .header('x-spine-kind', meta.kind)
      .header('x-spine-profile', meta.profile_id)
      .header('x-spine-wrapped-key', meta.wrapped_key)
      .send(bytes);
  });

  app.put<{ Params: { id: string }; Body: Buffer }>(
    '/api/vault/objects/:id',
    { preHandler: [requireAuth, app.rateLimit({ max: 600, timeWindow: '1 minute' })] },
    async (req, reply) => {
      const { id } = req.params;
      const header = (name: string) => {
        const v = req.headers[name];
        return typeof v === 'string' ? v : '';
      };
      const kind = header('x-spine-kind');
      const profile = header('x-spine-profile');
      const wrappedKey = header('x-spine-wrapped-key');
      const base = header('x-spine-base-seq') || '0';
      const body = req.body;
      if (!OBJECT_ID.test(id) || !KINDS.has(kind) || !OBJECT_ID.test(profile) || !/^[A-Za-z0-9_-]{90,200}$/.test(wrappedKey) || !SEQ.test(base) || !Buffer.isBuffer(body) || body.length === 0) {
        return reply.status(400).send({ error: 'an object needs an id, a kind, a profile, a wrapped key, the sequence you last saw and a body' });
      }
      const store = getStore();
      const result = await store.vault.put(req.userId, { id, profileId: profile, kind, size: body.length, wrappedKey, baseSeq: Number(base) }, new Date().toISOString(), vaultLimits().accountBytes);
      if (result === 'no_vault') return reply.status(404).send({ error: 'this account has no vault yet', code: 'no_vault' });
      if (result === 'conflict') return reply.status(409).send({ error: 'this object changed elsewhere; fetch it again', code: 'conflict' });
      if (result === 'quota') return reply.status(413).send({ error: 'the vault is full', code: 'quota' });
      writeObject(req.userId, id, body);
      return reply.send({ seq: result.seq });
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { base?: string } }>(
    '/api/vault/objects/:id',
    { preHandler: [requireAuth, app.rateLimit({ max: 600, timeWindow: '1 minute' })] },
    async (req, reply) => {
      const base = req.query.base ?? '';
      if (!OBJECT_ID.test(req.params.id) || !SEQ.test(base)) return reply.status(400).send({ error: 'an id and the sequence you last saw are needed' });
      const done = await getStore().vault.remove(req.userId, req.params.id, Number(base), new Date().toISOString());
      if (!done) return reply.status(409).send({ error: 'no such object, or it changed elsewhere', code: 'conflict' });
      removeObject(req.userId, req.params.id);
      return reply.send({ seq: done.seq });
    },
  );
}

/**
 * Stores keys and, when a value is given, makes it the account's credential in the same step, ending the other sign-ins and keeping this
 * one. Used by the vault's own routes and by a reset.
 */
export async function changeCredential(
  req: { session: unknown },
  userId: string,
  authValue: string | null,
  keys: NonNullable<ReturnType<typeof parseVaultKeys>>,
  replace: boolean,
): Promise<void> {
  const store = getStore();
  const now = new Date().toISOString();
  if (authValue) await store.users.setPassword(userId, await hashPassword(authValue));
  if (replace) await store.vault.replaceKeys(userId, keys, now);
  else await store.vault.putKeys(userId, keys, now);
  if (authValue) {
    const session = req.session as SessionData;
    session.authVersion = (await store.users.findById(userId))?.auth_version ?? session.authVersion;
    await endOtherSessions(userId, session);
  }
}

