import { ModelBudgetError } from '../llm/budget.js';
import type { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from './middleware.js';
import { streamReply } from './ndjson.js';
import { acceptParts, AttachRefused } from '../ingestion/accept-parts.js';
import { chatEnabled } from '../config.js';
import { getStore } from '../store/index.js';
import { MAX_MESSAGES } from '../store/types.js';
import { askQuestion, MAX_QUESTION, MAX_TURNS, type ChatProgress, type ChatReply } from '../chat/index.js';
import { checkScreen, type ScreenContext } from '../chat/screen.js';
import type { ChatTurn } from '../llm/types.js';
import { logger } from '../logger.js';
import { describeError } from '../failure.js';

const MAX_TITLE = 60;
const LIST_LIMIT = 200;

/** An answer's citations are labels that belong to the request that made them; in a later one they would point at nothing. */
const withoutCitations = (text: string) => text.replace(/\s*\[[DTCS]\d+(?:\.[a-z]+)?\]/g, '');

const titleOf = (question: string) => {
  const flat = question.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1)}…` : flat;
};

/**
 * Questions about the owner's own records, and the conversations they are kept in. Owner session only. A share link's recipient has their own, narrower route (`POST /api/share/:token/chat`, in
 * `public-share.ts`, SECURITY.md M-20) and none of these conversations. A conversation is the owner's medical text, so every read and write goes through the store as them, and one that
 * is not theirs is a 404.
 */
export interface ChatRouteOptions {
  /** Questions a minute per source. An option so tests that ask many do not meet the real limit. */
  askPerMinute?: number;
}

export async function chatRoutes(app: FastifyInstance, opts: ChatRouteOptions = {}) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/chat/status', async (_req, reply) => reply.header('Cache-Control', 'no-store').send({ enabled: chatEnabled() }));

  // How many conversations the app started (an upload finished) are waiting to be opened. Polled by the page, so it is cheap.
  app.get('/api/chat/unread', async (req, reply) =>
    reply.header('Cache-Control', 'no-store').send({ count: chatEnabled() ? await getStore().conversations.unreadCount(req.userId) : 0 }));

  app.post<{ Params: { id: string } }>('/api/chat/conversations/:id/read', async (req, reply) => {
    if (!(await getStore().conversations.markRead(req.userId, req.params.id))) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });

  // A file attached in the chat (pasted, dropped or chosen): the ordinary upload, tied to the conversation it was attached in, so what
  // happens to it (read, found, needs checking) is reported there (SECURITY.md M-25). A `conversation_id` field sent before the files
  // names the conversation; without one a new conversation is started. Nothing is read from the message: the file is the upload route's.
  app.post('/api/chat/attachments', { config: { rateLimit: { max: Math.max(10, Math.floor((opts.askPerMinute ?? 20) / 2)), timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!chatEnabled()) return reply.status(409).send({ error: 'asking questions is switched off' });
    const store = getStore();
    let conversationId: string | null = null;
    let startedHere = false;
    let results: Awaited<ReturnType<typeof acceptParts>>;
    try {
      results = await acceptParts(req.userId, req.parts(), {
        conversationFor: async fields => {
          const named = fields.conversation_id;
          if (named !== undefined) {
            const found = named.length <= 64 ? await store.conversations.find(req.userId, named) : null;
            if (!found) throw new AttachRefused(404, 'not found');
            if (found.message_count >= MAX_MESSAGES) throw new AttachRefused(409, 'this conversation is full; start a new one');
            return (conversationId = found.id);
          }
          conversationId = uuidv4();
          startedHere = true;
          await store.conversations.create(req.userId, { id: conversationId, title: 'Attached files', createdAt: new Date().toISOString() });
          return conversationId;
        },
      });
    } catch (err) {
      // Refused before the first file was saved: a conversation that is not theirs, or one that is full.
      if (err instanceof AttachRefused) return reply.status(err.status).send({ error: err.message });
      throw err;
    }
    if (conversationId === null) return reply.status(400).send({ error: 'attach at least one file' });

    // A file found already held, or restored from a zip, is tied to this conversation too, so the report comes here.
    const files: Array<{ name: string | null; upload_id: string | null; state: 'reading' | 'already_held' | 'skipped'; reason: string | null }> = [];
    for (const r of results) {
      if ('id' in r && typeof r.id === 'string') {
        await store.sourceFiles.setChatConversation(req.userId, r.id, conversationId);
        files.push({ name: (await store.sourceFiles.findFor(req.userId, r.id))?.original_filename ?? null, upload_id: r.id, state: 'reading', reason: null });
      } else if ('reason' in r && r.reason === 'duplicate' && typeof r.existing_id === 'string') {
        files.push({ name: (await store.sourceFiles.findFor(req.userId, r.existing_id))?.original_filename ?? null, upload_id: r.existing_id, state: 'already_held', reason: 'duplicate' });
      } else {
        files.push({ name: typeof (r as { filename?: unknown }).filename === 'string' ? (r as { filename: string }).filename : null, upload_id: null, state: 'skipped', reason: String((r as { reason?: unknown }).reason ?? 'skipped') });
      }
    }
    const names = (state: string) => files.filter(f => f.state === state).map(f => f.name ?? 'a file').join(', ');
    const content = [
      'I attached files.',
      names('reading') && `Being read: ${names('reading')}.`,
      names('already_held') && `Already in the archive: ${names('already_held')}.`,
      names('skipped') && `Not accepted: ${files.filter(f => f.state === 'skipped').map(f => `${f.name ?? 'a file'} (${f.reason})`).join(', ')}.`,
    ].filter(Boolean).join(' ');
    const now = new Date().toISOString();
    await store.conversations.append(req.userId, conversationId, [{ id: uuidv4(), role: 'user', content, sources: [], note: null, createdAt: now, kind: 'attachment', data: { files } }]);
    const first = files.find(f => f.name)?.name;
    if (startedHere && first) await store.conversations.rename(req.userId, conversationId, first.length > MAX_TITLE ? `${first.slice(0, MAX_TITLE - 1)}…` : first);
    const conversation = await store.conversations.find(req.userId, conversationId);
    return reply.header('Cache-Control', 'no-store').send({ conversation: { id: conversationId, title: conversation?.title ?? 'Attached files' }, files });
  });

  // Their conversations, most recent first.
  app.get('/api/chat/conversations', async (req, reply) =>
    reply.header('Cache-Control', 'no-store').send(await getStore().conversations.list(req.userId, LIST_LIMIT)));

  // One conversation with its messages, to continue it.
  app.get<{ Params: { id: string } }>('/api/chat/conversations/:id', async (req, reply) => {
    const store = getStore();
    const conversation = await store.conversations.find(req.userId, req.params.id);
    if (!conversation) return reply.status(404).send({ error: 'not found' });
    return reply.header('Cache-Control', 'no-store').send({ ...conversation, messages: await store.conversations.messages(req.userId, conversation.id) });
  });

  app.patch<{ Params: { id: string }; Body: { title?: unknown } }>('/api/chat/conversations/:id', async (req, reply) => {
    const title = req.body?.title;
    if (typeof title !== 'string' || !title.trim() || title.length > 120) return reply.status(400).send({ error: 'title is required, at most 120 characters' });
    if (!(await getStore().conversations.rename(req.userId, req.params.id, title.replace(/\s+/g, ' ').trim()))) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });

  app.delete<{ Params: { id: string } }>('/api/chat/conversations/:id', async (req, reply) => {
    if (!(await getStore().conversations.remove(req.userId, req.params.id))) return reply.status(404).send({ error: 'not found' });
    return reply.send({ ok: true });
  });

  // All of them: for the person who wants none of it kept.
  app.delete('/api/chat/conversations', async (req, reply) => reply.send({ removed: await getStore().conversations.removeAll(req.userId) }));

  // Each question costs model calls (an agent may make several), so it is limited more tightly than a lookup. The conversation
  // it belongs to is read from the store, never from the browser: the browser names it, and it must be theirs.
  //
  // With `stream: true` the reply is a stream of JSON lines (NDJSON) instead of one JSON body: `step` (what the agent is looking
  // up), `delta` (a piece of the answer as it is written), `reset` (what was shown was not the answer), then `done` with the
  // reply exactly as the plain form would have sent it, or `error`. Everything is checked before the first byte, so a refusal is
  // an ordinary 4xx either way. The answer is kept only once it is complete, as before: a question the person walked away from
  // leaves nothing behind.
  app.post<{ Body: { question?: unknown; conversation_id?: unknown; screen?: unknown; stream?: unknown } }>('/api/chat', { config: { rateLimit: { max: opts.askPerMinute ?? 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!chatEnabled()) return reply.status(409).send({ error: 'asking questions is switched off' });
    const { question, conversation_id: conversationId, screen, stream } = req.body ?? {};
    if (typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION) {
      return reply.status(400).send({ error: `question is required, at most ${MAX_QUESTION} characters` });
    }
    let where: ScreenContext | null = null;
    if (screen !== undefined) {
      const checked = checkScreen(screen);
      if (typeof checked === 'string') return reply.status(400).send({ error: checked });
      where = checked;
    }

    const store = getStore();
    let history: ChatTurn[] = [];
    let conversation = null as Awaited<ReturnType<typeof store.conversations.find>>;
    if (conversationId !== undefined) {
      if (typeof conversationId !== 'string' || conversationId.length > 64) return reply.status(400).send({ error: 'conversation_id must be an id' });
      conversation = await store.conversations.find(req.userId, conversationId);
      if (!conversation) return reply.status(404).send({ error: 'not found' });
      if (conversation.message_count >= MAX_MESSAGES) return reply.status(409).send({ error: 'this conversation is full; start a new one' });
      const recent = await store.conversations.messages(req.userId, conversation.id, MAX_TURNS * 2);
      history = recent
        .filter(m => !m.note && m.content.trim())
        .map(m => ({ role: m.role, content: m.role === 'assistant' ? withoutCitations(m.content) : m.content }));
      // A conversation the app began about an upload stays about it: the upload is on screen for the assistant even when the
      // owner is on another page, so "is this grouped right?" has an answer. The id is the app's, from its own notice.
      const notice = [...recent].reverse().find(m => m.kind === 'upload' || m.kind === 'regroup');
      const uploadId = (notice?.data as { upload_id?: unknown } | null | undefined)?.upload_id;
      if (typeof uploadId === 'string' && !where?.uploadId) where = { ...(where ?? { page: 'other' as const }), uploadId };
    }

    type Outcome = { status: 200; body: ChatReply & { conversation: { id: string; title: string } } } | { status: number; error: string } | null;
    const answerAndKeep = async (progress: ChatProgress): Promise<Outcome> => {
      let answered;
      try {
        answered = await askQuestion(req.userId, question.trim(), history, where, progress);
      } catch (err) {
        // The person went away: nothing to say and nothing to keep.
        if (progress.signal?.aborted) return null;
        // A model's reply can quote the records; describeError drops the quote, so the log holds no medical text.
        logger.warn('a question could not be answered', { error: describeError(err) });
        if (err instanceof ModelBudgetError) return { status: 429, error: 'the daily limit on model calls is reached; it starts again at midnight UTC' };
        return { status: 502, error: 'could not answer just now' };
      }
      if (!answered) return { status: 502, error: 'could not answer just now' };

      // Kept only once there is an answer (or a plain "nothing matches"): a failed try leaves nothing behind.
      const now = new Date().toISOString();
      if (!conversation) {
        const id = uuidv4();
        await store.conversations.create(req.userId, { id, title: titleOf(question), createdAt: now });
        conversation = await store.conversations.find(req.userId, id);
      }
      await store.conversations.markRead(req.userId, conversation!.id);
      await store.conversations.append(req.userId, conversation!.id, [
        { id: uuidv4(), role: 'user', content: question.trim(), sources: [], note: null, createdAt: now },
        { id: uuidv4(), role: 'assistant', content: answered.answer ?? '', sources: answered.sources, note: answered.answer === null ? 'none' : null, createdAt: new Date().toISOString() },
      ]);
      return { status: 200, body: { ...answered, conversation: { id: conversation!.id, title: conversation!.title } } };
    };

    if (stream !== true) {
      const outcome = await answerAndKeep({});
      if (!outcome) return reply.status(502).send({ error: 'could not answer just now' });
      if ('error' in outcome) return reply.status(outcome.status).send({ error: outcome.error });
      return reply.header('Cache-Control', 'no-store').send(outcome.body);
    }

    // The stream (routes/ndjson.ts): a line every few seconds keeps a proxy from taking a slow model for a dead connection.
    return streamReply(reply, async progress => {
      const outcome = await answerAndKeep(progress);
      if (!outcome) return null;
      return 'error' in outcome ? { type: 'error', status: outcome.status, error: outcome.error } : { type: 'done', reply: outcome.body };
    }, 'kept');
  });
}
