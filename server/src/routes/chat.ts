import type { FastifyInstance } from 'fastify';
import { PassThrough } from 'node:stream';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from './middleware.js';
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
 * Questions about the owner's own records, and the conversations they are kept in. Owner session only: there is no chat on a
 * share link. A conversation is the owner's medical text, so every read and write goes through the store as them, and one that
 * is not theirs is a 404.
 */
export async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/chat/status', async (_req, reply) => reply.header('Cache-Control', 'no-store').send({ enabled: chatEnabled() }));

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
  app.post<{ Body: { question?: unknown; conversation_id?: unknown; screen?: unknown; stream?: unknown } }>('/api/chat', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
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
      history = (await store.conversations.messages(req.userId, conversation.id, MAX_TURNS * 2))
        .filter(m => !m.note && m.content.trim())
        .map(m => ({ role: m.role, content: m.role === 'assistant' ? withoutCitations(m.content) : m.content }));
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

    // The stream. `X-Accel-Buffering` tells nginx to pass each line on as it comes; a line every few seconds while nothing
    // else is happening keeps a proxy from taking a slow model for a dead connection.
    const out = new PassThrough();
    const aborted = new AbortController();
    let finished = false;
    reply.raw.on('close', () => { if (!finished) aborted.abort(); });
    const line = (event: object) => { if (!out.destroyed && !out.writableEnded) out.write(`${JSON.stringify(event)}\n`); };
    const beat = setInterval(() => line({ type: 'ping' }), 10_000);
    void (async () => {
      try {
        const outcome = await answerAndKeep({
          step: s => line({ type: 'step', ...s }),
          delta: text => line({ type: 'delta', text }),
          reset: () => line({ type: 'reset' }),
          signal: aborted.signal,
        });
        if (outcome) line('error' in outcome ? { type: 'error', status: outcome.status, error: outcome.error } : { type: 'done', reply: outcome.body });
      } catch (err) {
        logger.warn('a question could not be kept', { error: describeError(err) });
        line({ type: 'error', status: 502, error: 'could not answer just now' });
      } finally {
        finished = true;
        clearInterval(beat);
        out.end();
      }
    })();
    return reply.header('Cache-Control', 'no-store').header('X-Accel-Buffering', 'no').type('application/x-ndjson; charset=utf-8').send(out);
  });
}
