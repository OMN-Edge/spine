import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UsageRepository } from 'spine-core/store/types.js';
import { mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages, type AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { LLM_TASKS, type LlmTask, type TaskClients } from 'spine-core/llm/tasks.js';
import { LlmBlockedError } from 'spine-core/llm/types.js';
import type { Embedder } from 'spine-core/embedding/types.js';
import { EMBED_PATH, TASK_PATH, embedRequest, taskRequest, type StreamLine } from 'spine-core/relay/protocol.js';
import type { RelayGate } from '../billing/gate.js';
import type { RelayTask } from 'spine-core/billing/plans.js';
import { verifyToken } from './token.js';

/**
 * The relay: the one thing between a device and the model provider (docs/relay.md, SECURITY.md M-35). A device cannot hold Spine's
 * credential, so it sends the task here with a pass from the Spine server, and the relay runs it through the same provider adapters the
 * server uses (`llm/adapters/`, picked by `SPINE_LLM_PROVIDER`), which hold the credential. Which provider that is, is the relay's
 * configuration: the device speaks the neutral protocol in `protocol.ts` and never knows.
 *
 * What it keeps to: it **stores nothing and logs no content**. A request is read, answered and forgotten; the only things written down are
 * the task, the model, the status (and the provider's, when it failed), the sizes and the time. It runs only the tasks Spine has (`LLM_TASKS`) on the models it was configured
 * with, and a tool the device names is a declaration handed to the model, never something the relay runs. It does see what passes through
 * it, in plaintext: it ends the TLS connection. That is why the words are "does not store or log", not "cannot see".
 */
export interface RelayConfig {
  secret: string;
  /** The address the app is served from, which the browser needs to be told it may call this service. */
  allowedOrigin: string;
  /** Calls a user may make a day. */
  dailyCalls: number;
  /** Calls one share may make a day (a recipient's translations and questions): its pass is for `share:<id>`, counted apart from any account. */
  dailySharedCalls: number;
  /**
   * The demo (SECURITY.md M-39): its passes are for `demo:<address>`, an address kept as a keyed hash. Calls one address may make a day,
   * and calls all of them together may make a day, the bound on what visitors with no account cost the operator. 0 allows none.
   */
  dailyDemoCalls: number;
  dailyDemoTotalCalls: number;
  /** Where the day's calls are counted: the `usage` repository of the store the relay is configured with (`getAccountsStore()`). */
  usage: UsageRepository;
  /** Plans (`billing/gate.ts`): whether an account's plan includes a task and has allowance left, and what a call cost. Absent: no plans, only the daily counts. */
  gate?: RelayGate;
  maxBodyBytes: number;
  /** The largest request a share's pass may send (default 512 KiB): a recipient's question or translation is small, and a count of calls is no bound on cost while their size is free (SECURITY.md S-49). */
  maxShareBodyBytes?: number;
  /** The clients for a model id (the default when undefined), or null when that model is not offered. */
  clients: (model: string | undefined) => TaskClients | null;
  embedder: () => Embedder;
  log?: (line: Record<string, unknown>) => void;
  now?: () => number;
}

/** The count of every demo call together: no pass is ever for it, since an address's hash never has the `*`. */
const DEMO_TOTAL = 'demo:*';

/** What a demo visitor's browser asks for: reading the files it uploads, and nothing else (SECURITY.md M-39, S-49). */
const DEMO_TASKS: ReadonlySet<RelayTask> = new Set<RelayTask>(['continuation', 'extraction', 'page', 'pageThinking', 'stamps', 'grouping']);

/** What a recipient's browser asks the relay for: translations, questions (the agent and the plain answer) and the search's embeddings. */
const SHARE_TASKS: ReadonlySet<RelayTask> = new Set<RelayTask>(['translation', 'chat', 'agent', 'embed']);

export function createRelay(config: RelayConfig) {
  const now = config.now ?? Date.now;
  const log = config.log ?? (() => undefined);

  const reply = (res: ServerResponse, status: number, error: string, code?: string) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(code ? { error, code } : { error }));
  };

  /** Counts a call against the user's day; false if there is none left. A demo call counts against its address and against every demo's. */
  const spend = async (subject: string): Promise<boolean> => {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (subject.startsWith('demo:')) {
      if ((await config.usage.spend(subject, day, config.dailyDemoCalls)) === null) return false;
      return (await config.usage.spend(DEMO_TOTAL, day, config.dailyDemoTotalCalls)) !== null;
    }
    return (await config.usage.spend(subject, day, subject.startsWith('share:') ? config.dailySharedCalls : config.dailyCalls)) !== null;
  };

  const bodyLimit = (subject: string): number => (subject.startsWith('share:') ? Math.min(config.maxShareBodyBytes ?? 512 * 1024, config.maxBodyBytes) : config.maxBodyBytes);

  async function body(req: IncomingMessage, limit: number): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) return null;
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  /**
   * The words for a failure, never the provider's own message, which may quote what was sent. Whether asking again could help is said
   * in the code (protocol.ts): the provider turned the request itself down (a 4xx of its own: `rejected`), or it did not answer or was
   * busy (`unavailable`), which a device tries again later. The provider's status goes in the log, so an operator can tell them apart.
   */
  const failure = (err: unknown): { status: number; error: string; code: string; provider_status: number | null } => {
    if (err instanceof LlmBlockedError) return { status: 422, error: 'the model refused these words', code: 'blocked', provider_status: null };
    const provider = providerStatus(err);
    if (provider !== null && provider >= 400 && provider < 500 && provider !== 408 && provider !== 429) {
      return { status: 502, error: 'the model provider turned the request down', code: 'rejected', provider_status: provider };
    }
    return { status: 503, error: 'the model provider could not answer', code: 'unavailable', provider_status: provider };
  };
  /** A call the device gave up on (the page closed, a reload) is logged as such, not as the provider failing: nginx's 499. */
  const CLOSED = 499;

  /** Each runner answers whether the call succeeded, which is when it is charged to the plan. */
  async function runTask(task: LlmTask, req: IncomingMessage, res: ServerResponse, payload: Buffer, started: number): Promise<boolean> {
    const parsed = taskRequest.safeParse(safeJson(payload));
    if (!parsed.success) { reply(res, 400, 'not a request this service understands'); return false; }
    const { model, messages, tools, stream } = parsed.data;
    const clients = config.clients(model);
    if (!clients) { reply(res, 400, 'that model is not offered'); return false; }
    const label = { task, model: model ?? 'default' };
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    let history: BaseMessage[];
    try { history = mapStoredMessagesToChatMessages(messages as never); } catch { reply(res, 400, 'not a request this service understands'); return false; }

    try {
      if (task !== 'agent') {
        const result = await clients[task].invoke(history, { signal: abort.signal });
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ result }));
        log({ ...label, status: 200, bytes_in: payload.length, ms: now() - started });
        return true;
      }
      const agent = clients.agent as unknown as BaseChatModel & { bindTools?: (t: unknown[]) => BaseChatModel };
      const bound = tools && tools.length > 0 && agent.bindTools ? agent.bindTools(tools) : agent;
      if (!stream) {
        const message = (await bound.invoke(history, { signal: abort.signal })) as AIMessage;
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ message: mapChatMessagesToStoredMessages([message])[0] }));
        log({ ...label, status: 200, bytes_in: payload.length, ms: now() - started });
        return true;
      }
      // Streamed: one JSON line a piece. Once the status is sent, a failure can only be said in a line.
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      let status = 200;
      let fromProvider: number | null = null;
      try {
        for await (const chunk of await bound.stream(history, { signal: abort.signal })) {
          const line: StreamLine = { chunk: { content: chunk.content, tool_call_chunks: (chunk as { tool_call_chunks?: unknown[] }).tool_call_chunks, additional_kwargs: chunk.additional_kwargs, response_metadata: chunk.response_metadata, usage_metadata: (chunk as { usage_metadata?: unknown }).usage_metadata, id: chunk.id } };
          res.write(`${JSON.stringify(line)}\n`);
        }
      } catch (err) {
        const f = failure(err);
        status = abort.signal.aborted ? CLOSED : f.status;
        fromProvider = f.provider_status;
        if (!abort.signal.aborted) res.write(`${JSON.stringify({ error: f.error, code: f.code } satisfies StreamLine)}\n`);
      }
      res.end();
      log({ ...label, status, ...(fromProvider !== null ? { provider_status: fromProvider } : {}), bytes_in: payload.length, ms: now() - started });
      return status === 200;
    } catch (err) {
      const f = failure(err);
      if (!res.headersSent) reply(res, f.status, f.error, f.code); else res.end();
      log({ ...label, status: abort.signal.aborted ? CLOSED : f.status, ...(f.provider_status !== null ? { provider_status: f.provider_status } : {}), bytes_in: payload.length, ms: now() - started });
      return false;
    }
  }

  async function runEmbed(res: ServerResponse, payload: Buffer, started: number): Promise<boolean> {
    const parsed = embedRequest.safeParse(safeJson(payload));
    if (!parsed.success) { reply(res, 400, 'not a request this service understands'); return false; }
    try {
      const embedder = config.embedder();
      if (!embedder.enabled) { reply(res, 404, 'embeddings are not set up here'); return false; }
      const vectors = await embedder.embed(parsed.data.texts, parsed.data.kind);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ vectors: vectors.map(v => Array.from(v)), id: embedder.id }));
      log({ task: 'embed', model: embedder.id, status: 200, bytes_in: payload.length, ms: now() - started });
      return true;
    } catch (err) {
      const f = failure(err);
      reply(res, f.status, f.error, f.code);
      log({ task: 'embed', model: 'embedder', status: f.status, ...(f.provider_status !== null ? { provider_status: f.provider_status } : {}), bytes_in: payload.length, ms: now() - started });
      return false;
    }
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = now();
    res.setHeader('access-control-allow-origin', config.allowedOrigin);
    res.setHeader('vary', 'origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'authorization, content-type, x-spine-work, x-spine-pages, x-spine-import', 'access-control-max-age': '600' });
      return void res.end();
    }
    if (req.method === 'GET' && req.url === '/healthz') return reply(res, 200, 'ok');

    const path = (req.url ?? '').split('?', 1)[0];
    const task = TASK_PATH.exec(path)?.[1];
    const isEmbed = path === EMBED_PATH;
    if (req.method !== 'POST' || (!isEmbed && !(task && (LLM_TASKS as readonly string[]).includes(task)))) return reply(res, 404, 'not a call this service makes');
    if ((req.url ?? '') !== path) return reply(res, 400, 'unexpected query');

    const relayTask: RelayTask = isEmbed ? 'embed' : (task as LlmTask);
    // A call turned away before it runs is written down too (with the task and the status, nothing of who or what), so a day's
    // allowance running out shows in the log and not only in the browser that was refused.
    const refuse = (status: number, error: string, code?: string) => {
      log({ task: relayTask, status, ...(code ? { code } : {}), ms: now() - started });
      reply(res, status, error, code);
    };
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    const who = bearer ? verifyToken(config.secret, bearer, now()) : null;
    if (!who) return refuse(401, 'sign in again');
    // A share's pass is given to whoever holds its link, so it runs only what a recipient does: reading, translating, asking and searching
    // (S-48). Turned away before it is counted, so a refused call does not use the share's day.
    if (who.userId.startsWith('share:') && !SHARE_TASKS.has(relayTask)) return refuse(403, 'a share’s pass does not run this call', 'task_not_for_share');
    // A demo reads uploads and nothing else (S-49).
    if (who.userId.startsWith('demo:') && !DEMO_TASKS.has(relayTask)) return refuse(403, 'a demo’s pass does not run this call', 'task_not_for_demo');
    // A request over what this kind of pass needs is turned away before it is counted, when its length is known.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > bodyLimit(who.userId)) return refuse(413, 'too large', 'too_large');
    if (!(await spend(who.userId))) return refuse(429, 'the daily allowance of model calls is used up');
    // What the device says about the call for the plan's counts (billing/gate.ts): a random id for the piece of work it belongs to, how many pages
    // it covers, and that it is part of an archive import. Shapes are checked; none is logged.
    const asked = String(req.headers['x-spine-work'] ?? '');
    const pagesSaid = Number(req.headers['x-spine-pages']);
    const call = {
      work: /^[A-Za-z0-9_-]{8,64}$/.test(asked) ? asked : null,
      pages: Number.isInteger(pagesSaid) && pagesSaid >= 1 && pagesSaid <= 1000 ? pagesSaid : null,
      bulk: req.headers['x-spine-import'] === '1',
    };
    const refusal = await config.gate?.admit(who.userId, relayTask, call);
    if (refusal) return refuse(refusal.status, refusal.error, refusal.code);

    const payload = await body(req, bodyLimit(who.userId));
    if (!payload) return reply(res, 413, 'too large');
    const ok = isEmbed ? await runEmbed(res, payload, started) : await runTask(task as LlmTask, req, res, payload, started);
    if (ok) await config.gate?.settle(who.userId, relayTask, payload.length, call).catch(() => log({ task: relayTask, note: 'the call could not be charged to the plan' }));
  };
}

function safeJson(payload: Buffer): unknown {
  try { return JSON.parse(payload.toString('utf8')); } catch { return null; }
}

/**
 * The status the provider answered with, from the shapes its SDKs throw: a `status` (Anthropic), a `response.status` (Google's HTTP
 * client), or only the words "status code 400" (LangChain's Vertex wrapper). Null when there was no answer: a timeout, a dropped connection.
 */
function providerStatus(err: unknown): number | null {
  for (let e: unknown = err, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const { status, response, message } = e as { status?: unknown; response?: { status?: unknown }; message?: unknown };
    if (typeof status === 'number') return status;
    if (typeof response?.status === 'number') return response.status;
    const said = /status code (\d{3})/.exec(typeof message === 'string' ? message : '');
    if (said) return Number(said[1]);
  }
  return null;
}
