import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getStore, type ShareLinkPatch } from '../store/index.js';
import { requireAuth } from './middleware.js';
import { publicUrl } from '../config.js';
import { isSupportedLanguage, SUPPORTED_LANGUAGES } from '../languages.js';
import { warmTranslations } from '../translation.js';
import { getMailer } from '../mail/index.js';
import { createShareToken, hashShareToken } from '../share-token.js';
import {
  resolveScope,
  resolveStoredScope,
  serializeScopeValue,
  ScopeError,
  type ResolvedScope,
} from '../share-scope.js';

/**
 * A scope that can be stored: P2 (a link whose scope cannot be fully resolved must not exist, which is what stops a `tag` link
 * with no tag from being read as "every document", S-1) and M-5 (a link may name only the owner's own documents, with one message
 * for "not yours" and "does not exist" so it cannot probe for another user's ids). Creating and changing a link both use it.
 */
async function checkScope(userId: string, scope: unknown, scopeValue: unknown): Promise<{ resolved: ResolvedScope } | { error: string }> {
  let resolved: ResolvedScope;
  try {
    resolved = resolveScope(scope, scopeValue);
  } catch (err) {
    if (err instanceof ScopeError) return { error: err.message };
    throw err;
  }
  if (resolved.scope === 'document_ids') {
    const unique = [...new Set(resolved.ids)];
    const owned = await getStore().documents.ownedIds(userId, unique);
    if (owned.length !== unique.length) return { error: 'one or more documents were not found' };
  }
  return { resolved };
}

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
      include_scans?: unknown;
      language?: unknown;
      require_approval?: unknown;
      allow_chat?: unknown;
    };
  }>('/api/share-links', async (req, reply) => {
    const { label, scope, scope_value, expires_days = 7, include_scans = false, language = null, require_approval = false, allow_chat = false } = req.body ?? {};

    if (!scope) return reply.status(400).send({ error: 'scope required' });
    if (expires_days < 1 || expires_days > 30) {
      return reply.status(400).send({ error: 'expires_days must be 1-30' });
    }
    if (typeof include_scans !== 'boolean') return reply.status(400).send({ error: 'include_scans must be true or false' });
    if (typeof require_approval !== 'boolean') return reply.status(400).send({ error: 'require_approval must be true or false' });
    if (typeof allow_chat !== 'boolean') return reply.status(400).send({ error: 'allow_chat must be true or false' });
    if (language !== null && !isSupportedLanguage(language)) return reply.status(400).send({ error: `language must be one of ${SUPPORTED_LANGUAGES.join(', ')}, or left out` });

    // P2 and M-5: see `checkScope`.
    const checked = await checkScope(req.userId, scope, scope_value);
    if ('error' in checked) return reply.status(400).send({ error: checked.error });
    const resolved = checked.resolved;

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
      includeScans: include_scans,
      language,
      requireApproval: require_approval,
      allowChat: allow_chat,
    });

    // A link that starts in a language: have its documents translated into it already, so the first reader
    // does not wait. In the background; a failure is logged and the reader asks again.
    if (language) {
      const link = { id, userId: req.userId, scope: resolved.scope, scopeValue: serializeScopeValue(resolved), expiresAt: expires.toISOString(), includeScans: include_scans, language, requireApproval: require_approval, allowChat: allow_chat };
      void getStore().documents.listForShare(link).then(docs => warmTranslations(req.userId, docs.map(d => d.id), language)).catch(() => undefined);
    }

    const url = publicUrl(`/share/${token}`);
    // `approval_mail`: whether the owner will be told by mail. Without a mailer the requests wait on the Share links page.
    return reply.status(201).send({ id, token, url, expires_at: expires.toISOString(), approval_mail: require_approval ? getMailer().enabled : null });
  });

  // Browsers waiting to open links that need approval (M-19), and the owner's decision. The mail's link opens the page
  // for one request; deciding is a POST from the signed-in owner, never a GET, so a mail scanner that follows the link
  // cannot approve anything.
  app.get('/api/share-requests', async (req, reply) => {
    return reply.header('Cache-Control', 'no-store').send(await getStore().shareLinks.listRequests(req.userId, new Date().toISOString()));
  });

  app.get<{ Params: { id: string } }>('/api/share-requests/:id', async (req, reply) => {
    const found = await getStore().shareLinks.getRequest(req.userId, req.params.id, new Date().toISOString());
    if (!found) return reply.status(404).send({ error: 'not found' });
    return reply.header('Cache-Control', 'no-store').send(found);
  });

  app.post<{ Params: { id: string }; Body: { decision?: unknown } }>('/api/share-requests/:id/decision', async (req, reply) => {
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'deny') return reply.status(400).send({ error: 'decision must be approve or deny' });
    const store = getStore();
    const now = new Date().toISOString();
    const found = await store.shareLinks.getRequest(req.userId, req.params.id, now);
    if (!found) return reply.status(404).send({ error: 'not found' });
    // Approving on a link that is gone would look like it worked; say it did not. Denying is always allowed.
    if (decision === 'approve' && !found.link_active) return reply.status(409).send({ error: 'this link is no longer active' });
    await store.shareLinks.decideRequest(req.userId, req.params.id, decision === 'approve' ? 'approved' : 'denied', now);
    return reply.send({ ok: true, status: decision === 'approve' ? 'approved' : 'denied' });
  });

  // One link, to inspect: how it is set now, what it shares now, who has read it, who asked, and what has happened to it.
  app.get<{ Params: { id: string } }>('/api/share-links/:id', async (req, reply) => {
    const store = getStore();
    const link = await store.shareLinks.findFor(req.userId, req.params.id);
    if (!link) return reply.status(404).send({ error: 'not found' });
    const now = new Date().toISOString();

    // What it shares today, resolved the way a recipient's read resolves it (so a document since set aside is not listed).
    let documents: Array<{ id: string; title: string | null; doc_date: string | null; doc_type: string | null; provider: string | null }> = [];
    let scopeOk = true;
    try {
      resolveStoredScope(link.scope, link.scope_value);
      const shared = await store.documents.listForShare({
        id: link.id, userId: req.userId, scope: link.scope, scopeValue: link.scope_value, expiresAt: link.expires_at,
        includeScans: link.include_scans, language: link.language, requireApproval: link.require_approval, allowChat: link.allow_chat,
      });
      documents = shared.slice(0, 300).map(d => ({ id: d.id, title: d.title, doc_date: d.doc_date, doc_type: d.doc_type, provider: d.provider }));
    } catch (err) {
      if (!(err instanceof ScopeError)) throw err;
      scopeOk = false;
    }

    const [access, requests, events] = await Promise.all([
      store.shareLinks.accessSummary(req.userId, link.id),
      store.shareLinks.listRequests(req.userId, now, link.id),
      store.shareLinks.eventsFor(req.userId, link.id, 100),
    ]);
    return reply.header('Cache-Control', 'no-store').send({ link, documents, scope_ok: scopeOk, access, requests, events });
  });

  // Change a link after it was made. The same checks as making one; a revoked link stays revoked. `expires_days` counts from now,
  // so it extends or shortens.
  const PATCHABLE = ['label', 'expires_days', 'include_scans', 'require_approval', 'allow_chat', 'language', 'scope', 'scope_value'];
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/share-links/:id', async (req, reply) => {
    const body = req.body ?? {};
    const unknown = Object.keys(body).filter(k => !PATCHABLE.includes(k));
    if (unknown.length > 0) return reply.status(400).send({ error: `unknown field(s): ${unknown.join(', ')}` });

    const patch: ShareLinkPatch = {};
    if (body.label !== undefined) {
      if (body.label !== null && (typeof body.label !== 'string' || body.label.length > 80)) return reply.status(400).send({ error: 'label must be text of at most 80 characters' });
      patch.label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : null;
    }
    if (body.expires_days !== undefined) {
      if (typeof body.expires_days !== 'number' || !Number.isInteger(body.expires_days) || body.expires_days < 1 || body.expires_days > 30) return reply.status(400).send({ error: 'expires_days must be 1-30' });
      patch.expiresAt = new Date(Date.now() + body.expires_days * 86_400_000).toISOString();
    }
    for (const [key, field] of [['include_scans', 'includeScans'], ['require_approval', 'requireApproval'], ['allow_chat', 'allowChat']] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') return reply.status(400).send({ error: `${key} must be true or false` });
      patch[field] = body[key] as boolean;
    }
    if (body.language !== undefined) {
      if (body.language !== null && !isSupportedLanguage(body.language)) return reply.status(400).send({ error: `language must be one of ${SUPPORTED_LANGUAGES.join(', ')}, or null` });
      patch.language = body.language as string | null;
    }
    if (body.scope !== undefined || body.scope_value !== undefined) {
      if (body.scope === undefined) return reply.status(400).send({ error: 'scope is required with scope_value' });
      const checked = await checkScope(req.userId, body.scope, body.scope_value);
      if ('error' in checked) return reply.status(400).send({ error: checked.error });
      patch.scope = checked.resolved.scope;
      patch.scopeValue = serializeScopeValue(checked.resolved);
    }

    const result = await getStore().shareLinks.update(req.userId, req.params.id, patch, new Date().toISOString());
    if (result === 'not_found') return reply.status(404).send({ error: 'not found' });
    if (result === 'revoked') return reply.status(409).send({ error: 'a revoked link cannot be changed' });
    return reply.send({ ok: true });
  });

  app.delete<{ Params: { id: string } }>('/api/share-links/:id', async (req, reply) => {
    const revoked = await getStore().shareLinks.revoke(req.userId, req.params.id);
    if (!revoked) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });
}
