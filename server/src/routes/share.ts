import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getStore } from '../store/index.js';
import { requireAuth } from './middleware.js';
import { publicUrl } from '../config.js';
import { createShareToken, hashShareToken } from '../share-token.js';
import {
  resolveScope,
  serializeScopeValue,
  ScopeError,
  type ResolvedScope,
} from '../share-scope.js';

export async function shareRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/share-links', async (req, reply) => {
    return reply.send(await getStore().shareLinks.listFor(req.userId));
  });

  app.post<{
    Body: {
      label?: string;
      scope: 'all' | 'tag' | 'document_ids' | 'date_range';
      scope_value?: unknown;
      expires_days?: number;
    };
  }>('/api/share-links', async (req, reply) => {
    const { label, scope, scope_value, expires_days = 7 } = req.body ?? {};

    if (!scope) return reply.status(400).send({ error: 'scope required' });
    if (expires_days < 1 || expires_days > 30) {
      return reply.status(400).send({ error: 'expires_days must be 1-30' });
    }

    // P2: a link whose scope cannot be fully resolved must not exist. Rejecting
    // here is what stops a `tag` link with no tag from being stored and then
    // read as "every document" (S-1).
    let resolved: ResolvedScope;
    try {
      resolved = resolveScope(scope, scope_value);
    } catch (err) {
      if (err instanceof ScopeError) return reply.status(400).send({ error: err.message });
      throw err;
    }

    // M-5: a link may name only the creator's own documents. Rejected here, not
    // filtered at read time, and with one message for "not yours" and "does not
    // exist" so it cannot be used to probe for another user's ids.
    if (resolved.scope === 'document_ids') {
      const unique = [...new Set(resolved.ids)];
      const owned = await getStore().documents.ownedIds(req.userId, unique);
      if (owned.length !== unique.length) {
        return reply.status(400).send({ error: 'one or more documents were not found' });
      }
    }

    // P6: only the digest is stored. This response is the one time the raw
    // token exists outside the recipient's URL bar.
    const token = createShareToken();
    const id = uuidv4();
    const now = new Date();
    const expires = new Date(now.getTime() + expires_days * 86_400_000);

    await getStore().shareLinks.create(req.userId, {
      id,
      tokenHash: hashShareToken(token),
      label: label ?? null,
      scope: resolved.scope,
      scopeValue: serializeScopeValue(resolved),
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
    });

    const url = publicUrl(`/share/${token}`);
    return reply.status(201).send({ id, token, url, expires_at: expires.toISOString() });
  });

  app.delete<{ Params: { id: string } }>('/api/share-links/:id', async (req, reply) => {
    const revoked = await getStore().shareLinks.revoke(req.userId, req.params.id);
    if (!revoked) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });
}
