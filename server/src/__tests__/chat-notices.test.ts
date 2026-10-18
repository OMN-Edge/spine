import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { buildTestApp, loginSession } from './helpers/app.js';
import { OWNER_ID, createTestUser, seedDocument, seedSourceFile, seedPage, TEST_PASSWORD } from './helpers/seed.js';
import { ScriptedModel } from './helpers/scripted-model.js';
import { getStore } from '../store/index.js';
import { announceUpload } from '../chat/notices.js';
import { resetChatLlm, type ChatLlm } from '../llm/index.js';

/**
 * The app starts a conversation when an upload has been read, and the owner reviews it by talking: what was read, what looks wrong,
 * fixing a field, reading a page again, confirming the grouping. Every change is still a proposal.
 */
let app: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;
const llmWith = (m: ScriptedModel | null) => ({ agentModel: () => m, answerQuestion: async () => null }) as unknown as ChatLlm;
const savedMulti = process.env.SPINE_MULTIMODAL_ENABLED;
const savedChat = process.env.SPINE_CHAT;

beforeAll(async () => { app = await buildTestApp(); cookie = await loginSession(app); });
afterAll(async () => { await app.close(); });
beforeEach(async () => {
  for (const f of await getStore().sourceFiles.listFor(OWNER_ID)) await getStore().sourceFiles.delete(OWNER_ID, f.id);
  await getStore().conversations.removeAll(OWNER_ID);
});
afterEach(() => {
  resetChatLlm();
  if (savedMulti === undefined) delete process.env.SPINE_MULTIMODAL_ENABLED; else process.env.SPINE_MULTIMODAL_ENABLED = savedMulti;
  if (savedChat === undefined) delete process.env.SPINE_CHAT; else process.env.SPINE_CHAT = savedChat;
});

/** An upload that has been read and waits for its grouping to be confirmed: three documents, one without a date, one empty page. */
async function readUpload() {
  const upload = await seedSourceFile({ status: 'done' });
  await getStore().sourceFiles.setGroupingConfirmed(OWNER_ID, upload, false);
  const make = async (title: string, withPage: boolean, date: string | null) => {
    const d = await seedDocument({ sourceFileId: upload, docDate: date, provider: null, aiSummary: `${title} summary`, withPage });
    await getStore().documents.update(OWNER_ID, d.id, { title });
    return d;
  };
  const a = await make('Blood count', true, '2026-02-01');
  const b = await make('Discharge letter', false, null);
  await seedPage(upload, { pageNumber: 2, rawText: '' });
  return { upload, a, b };
}
const conversations = () => app.inject({ method: 'GET', url: '/api/chat/conversations', headers: { cookie } });
const unread = async () => (await app.inject({ method: 'GET', url: '/api/chat/unread', headers: { cookie } })).json().count as number;
const toolText = (m: ScriptedModel) => m.seen.at(-1)!.filter(x => x.getType() === 'tool').map(x => String(x.content)).join('\n');

describe('the app starts a conversation when an upload has been read', () => {
  it('writes an unread notice with the facts, in data the page draws and in English for the model', async () => {
    const { upload } = await readUpload();
    await announceUpload(OWNER_ID, upload);

    expect(await unread()).toBe(1);
    const [c] = (await conversations()).json();
    expect(c).toMatchObject({ title: 'Upload finished', unread: true, origin: 'upload', message_count: 1 });
    const { messages } = (await app.inject({ method: 'GET', url: `/api/chat/conversations/${c.id}`, headers: { cookie } })).json();
    expect(messages[0]).toMatchObject({ role: 'assistant', kind: 'upload' });
    expect(messages[0].data).toMatchObject({ upload_id: upload, state: 'done', grouping_pending: true, undated_documents: 1 });
    expect(messages[0].data.documents.map((d: { title: string }) => d.title).sort()).toEqual(['Blood count', 'Discharge letter']);
    expect(messages[0].content).toMatch(/The grouping is waiting for the owner to confirm it/);
  });

  it('says so when an upload could not be read', async () => {
    const upload = await seedSourceFile({ status: 'pending' });
    await getStore().sourceFiles.setStatus(OWNER_ID, upload, 'error', 'boom: text from the file');
    await announceUpload(OWNER_ID, upload);
    const [c] = (await conversations()).json();
    expect(c.title).toBe('Upload failed');
    const { messages } = (await app.inject({ method: 'GET', url: `/api/chat/conversations/${c.id}`, headers: { cookie } })).json();
    expect(messages[0].data.state).toBe('failed');
    // The reason the file failed can quote the file: it is not copied into the conversation.
    expect(JSON.stringify(messages)).not.toMatch(/boom/);
  });

  it('writes nothing for an upload still being read, or when the chat is off', async () => {
    const pending = await seedSourceFile({ status: 'processing' });
    await announceUpload(OWNER_ID, pending);
    expect(await unread()).toBe(0);
    const { upload } = await readUpload();
    process.env.SPINE_CHAT = 'off';
    await announceUpload(OWNER_ID, upload);
    expect(await unread()).toBe(0);
  });

  it('is read once opened, and only its owner can say so', async () => {
    const { upload } = await readUpload();
    await announceUpload(OWNER_ID, upload);
    const [c] = (await conversations()).json();

    await createTestUser('peeker@spine.test');
    const other = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'peeker@spine.test', password: TEST_PASSWORD } })).cookies.map(x => `${x.name}=${x.value}`).join('; ');
    expect((await app.inject({ method: 'POST', url: `/api/chat/conversations/${c.id}/read`, headers: { cookie: other } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/chat/unread', headers: { cookie: other } })).json().count).toBe(0);
    expect(await unread()).toBe(1);

    expect((await app.inject({ method: 'POST', url: `/api/chat/conversations/${c.id}/read`, headers: { cookie } })).statusCode).toBe(200);
    expect(await unread()).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/chat/unread' })).statusCode).toBe(401);
  });
});

describe('reviewing an upload by talking', () => {
  it('keeps the conversation about the upload, shows it undone documents, and prepares fixes and the confirmation', async () => {
    const { upload, a, b } = await readUpload();
    await announceUpload(OWNER_ID, upload);
    const [c] = (await conversations()).json();

    const model = new ScriptedModel([
      { tools: [{ name: 'get_upload', args: { upload: 'U1' } }] },
      { tools: [
        { name: 'propose_edit_document', args: { document: 'D1', doc_date: '2026-02-03' } },
        { name: 'propose_confirm_grouping', args: { upload: 'U1' } },
      ] },
      { say: 'The discharge letter has no date; I proposed one. Confirm both when ready.' },
    ]);
    resetChatLlm(llmWith(model));
    const res = await app.inject({ method: 'POST', url: '/api/chat', headers: { cookie }, payload: { question: 'is this right?', conversation_id: c.id } });
    expect(res.statusCode).toBe(200);

    // The notice is in the history the model reads, and the upload is on screen though the owner sent no screen.
    const first = model.seen[0].map(x => String(x.content)).join('\n');
    expect(first).toContain('has been read: 2 documents');
    expect(first).toContain('The upload on screen is U1');
    // The documents of an upload still waiting for its grouping are readable here, and by label only.
    expect(toolText(model)).toMatch(/D\d: pages .*Blood count/);
    expect(toolText(model)).toContain('NO DATE');
    expect(toolText(model)).toContain('grouping NOT yet confirmed');

    const proposals = res.json().proposals as Array<{ kind: string; calls: Array<{ method: string; path: string; body?: unknown }> }>;
    expect(proposals.map(p => p.kind).sort()).toEqual(['confirm_grouping', 'edit_document']);
    expect(await unread()).toBe(0); // replying opened it
    expect((await getStore().sourceFiles.findFor(OWNER_ID, upload))!.grouping_confirmed).toBe(false);

    // Confirm, as the page does: the ordinary routes accept what was prepared, including a date on an unconfirmed document.
    for (const p of proposals) {
      for (const call of p.calls) {
        const r = await app.inject({ method: call.method as 'POST', url: call.path, payload: call.body as object | undefined, headers: { cookie } });
        expect(r.statusCode, `${p.kind} ${call.path}`).toBe(200);
      }
    }
    expect((await getStore().sourceFiles.findFor(OWNER_ID, upload))!.grouping_confirmed).toBe(true);
    // Which document is D1 is the order the upload listed them in; the one the proposal named is the one that changed.
    const edited = (proposals.find(p => p.kind === 'edit_document') as unknown as { document: { id: string } }).document.id;
    expect([a.id, b.id]).toContain(edited);
    expect((await getStore().documents.findFor(OWNER_ID, edited))!.doc_date).toBe('2026-02-03');
  });

  it('refuses to confirm a grouping that is already confirmed, or an upload it was not shown', async () => {
    const { upload } = await readUpload();
    const model = new ScriptedModel([
      { tools: [{ name: 'list_uploads', args: {} }] },
      { tools: [{ name: 'propose_confirm_grouping', args: { upload: 'U1' } }, { name: 'propose_confirm_grouping', args: { upload: 'U9' } }] },
      { say: 'ok' },
    ]);
    await getStore().sourceFiles.setGroupingConfirmed(OWNER_ID, upload, true);
    resetChatLlm(llmWith(model));
    const res = await app.inject({ method: 'POST', url: '/api/chat', headers: { cookie }, payload: { question: 'confirm it', screen: { page: 'upload' } } });
    expect(res.json().proposals).toBeUndefined();
    expect(toolText(model)).toMatch(/already confirmed/);
    expect(toolText(model)).toMatch(/no upload U9/);
  });

  it('prepares reading a page again, naming where the image goes, only if the server allows it', async () => {
    const { a } = await readUpload();
    const script = [
      { tools: [{ name: 'search_documents', args: { query: 'blood count' } }] },
      { tools: [{ name: 'propose_reread_pages', args: { document: 'D1', pages: [1] } }] },
      { say: 'ok' },
    ];
    delete process.env.SPINE_MULTIMODAL_ENABLED;
    const refused = new ScriptedModel(script);
    resetChatLlm(llmWith(refused));
    await getStore().sourceFiles.setGroupingConfirmed(OWNER_ID, (await getStore().documents.findFor(OWNER_ID, a.id))!.source_file_id, true);
    const none = await app.inject({ method: 'POST', url: '/api/chat', headers: { cookie }, payload: { question: 'read page 1 again' } });
    expect(none.json().proposals).toBeUndefined();
    expect(toolText(refused)).toMatch(/not enabled on this server/);

    process.env.SPINE_MULTIMODAL_ENABLED = 'true';
    const allowed = new ScriptedModel(script);
    resetChatLlm(llmWith(allowed));
    const res = await app.inject({ method: 'POST', url: '/api/chat', headers: { cookie }, payload: { question: 'read page 1 again' } });
    const p = res.json().proposals[0];
    expect(p).toMatchObject({ kind: 'reread_pages', page_numbers: [1], strategy: 'model', sends_images: true });
    expect(p.calls[0]).toMatchObject({ method: 'POST', body: { strategy: 'model' } });
    expect(p.calls[0].path).toMatch(/^\/api\/source-files\/[\w-]+\/ai-reading$/);
  });
});
