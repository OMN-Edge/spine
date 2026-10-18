import { v4 as uuidv4 } from 'uuid';
import { buildTestApp, loginSession } from '../../__tests__/helpers/app.js';
import { OWNER_ID } from '../../__tests__/helpers/seed.js';
import { getStore } from '../../store/index.js';
import type { Proposal } from '../../chat/proposals.js';

/**
 * A running app with a signed-in owner, and the ways a person drives it: type to the assistant, attach a file, press Confirm on a
 * card. Everything goes through the HTTP routes, as the browser does; the store is read directly only to check what happened.
 */
export async function startWorld() {
  const app = await buildTestApp();
  const cookie = await loginSession(app);
  return { app, cookie };
}
export type World = Awaited<ReturnType<typeof startWorld>>;

export interface Reply {
  answer: string | null;
  sources: Array<{ label: string; id: string; title: string | null }>;
  proposals?: Proposal[];
  conversation: { id: string; title: string };
  looked?: string[];
}

/** Ask the assistant something, as the panel does (without streaming). */
export async function ask(w: World, question: string, options: { conversation?: string | null; screen?: Record<string, unknown> } = {}): Promise<Reply> {
  const res = await w.app.inject({
    method: 'POST', url: '/api/chat', headers: { cookie: w.cookie },
    payload: { question, conversation_id: options.conversation ?? undefined, screen: options.screen },
  });
  if (res.statusCode !== 200) throw new Error(`the assistant answered ${res.statusCode}: ${res.body.slice(0, 300)}`);
  return res.json() as Reply;
}

/** The first proposal of a kind, or a failure that shows what the assistant said instead. */
export function proposalOf<K extends Proposal['kind']>(reply: Reply, kind: K): Extract<Proposal, { kind: K }> {
  const found = reply.proposals?.find(p => p.kind === kind);
  if (!found) throw new Error(`no ${kind} proposal; it proposed [${(reply.proposals ?? []).map(p => p.kind).join(', ')}] and said: ${reply.answer?.slice(0, 300)}`);
  return found as Extract<Proposal, { kind: K }>;
}

/** What Confirm does for a card that carries its requests: send each to the real route as the owner. */
export async function confirm(w: World, proposal: { calls?: Array<{ method: string; path: string; body?: unknown }> }) {
  const statuses: number[] = [];
  for (const call of proposal.calls ?? []) {
    const res = await w.app.inject({ method: call.method as 'PATCH', url: call.path, headers: { cookie: w.cookie }, payload: call.body as object | undefined });
    statuses.push(res.statusCode);
    if (res.statusCode >= 400) throw new Error(`${call.method} ${call.path} -> ${res.statusCode}: ${res.body.slice(0, 200)}`);
  }
  return statuses;
}

/** Wait for something that happens in the background, up to a limit, and say what it was waiting for if it never does. */
export async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 120_000, everyMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await new Promise(r => setTimeout(r, everyMs));
  }
}

const B = 'ItBoundary';
/** Attach files in the chat, as the paperclip does. */
export async function attach(w: World, files: Array<{ name: string; content: Buffer }>, conversation?: string) {
  const chunks: Buffer[] = [];
  if (conversation) chunks.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="conversation_id"\r\n\r\n${conversation}\r\n`));
  for (const f of files) chunks.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: application/pdf\r\n\r\n`), f.content, Buffer.from('\r\n'));
  chunks.push(Buffer.from(`--${B}--`));
  const res = await w.app.inject({ method: 'POST', url: '/api/chat/attachments', headers: { cookie: w.cookie, 'content-type': `multipart/form-data; boundary=${B}` }, payload: Buffer.concat(chunks) });
  if (res.statusCode !== 200) throw new Error(`attaching answered ${res.statusCode}: ${res.body.slice(0, 300)}`);
  return res.json() as { conversation: { id: string; title: string }; files: Array<{ name: string | null; upload_id: string | null; state: string; reason: string | null }> };
}

/** The app's report of an upload, once it is in the conversation. */
export async function reportOf(w: World, conversation: string) {
  const message = await until('the report of the upload', async () =>
    (await getStore().conversations.messages(OWNER_ID, conversation)).find(m => m.kind === 'upload'), 240_000, 2000);
  return message;
}
export { OWNER_ID };
export const newId = () => uuidv4();
