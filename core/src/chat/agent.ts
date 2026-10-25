import { z } from 'zod';
import { spendModelCall } from '../llm/budget.js';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { AIMessage, HumanMessage, SystemMessage, type AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Annotation, StateGraph, MessagesAnnotation, START, END } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { getStore } from '../store/index.js';
import { chainOf } from '../linking/index.js';
import { buildAgentSystemPrompt, buildSharedAgentSystemPrompt } from '../llm/prompts.js';
import type { ChatTurn } from '../llm/types.js';
import type { Document } from '../types.js';
import { documentsForQuestion } from './retrieval.js';
import { sharedTestNames } from './share-tests.js';
import { buildActionTools } from './actions.js';
import type { DoctorEntry, Proposal } from './proposals.js';
import { DOCUMENT_SECTIONS, describeScreen, resolveScreen, sectionRecords, type DocumentSection, type ScreenContext } from './screen.js';
import type { ChatProgress, ChatReply, ChatSource, ChatStep } from './index.js';
import type { LinkWhy } from '../linking/why.js';

/**
 * The chat as an agent (LangGraph): the model is given read-only tools and decides what to look up, instead of code deciding
 * for it. What is on the person's screen is already in front of it, so most questions about "this" need no tool.
 *
 * What keeps this safe to run on a medical archive:
 *  - every tool takes `userId` from the state of the graph (set by the route; in no schema) and reads through the store, so
 *    the model cannot name another user, and an id is not something it can pass at all: it passes labels (D3) that this very
 *    request gave it, which the request maps to documents;
 *  - the loop is capped: at most `MAX_ROUNDS` rounds of tool calls, then it is told to answer; every result is cut, and the
 *    total a question may read is bounded (`TOTAL_BUDGET`), after which tools only say so;
 *  - there are no tools that change anything. A tool is `read` or `action` in `TOOL_KINDS`; when actions come they do not
 *    execute from here: they return a proposal that the person confirms in the interface, and the loop ends there;
 *  - documents are untrusted text, as in the fixed pipeline: the system prompt says so.
 */
/**
 * Rounds of tool calls before the model is told to answer. The owner's agent needs room for a request that takes several steps (find the
 * visits, follow them to their tests, read a plan, then propose): the first live run of "send both visits and the March tests" used all
 * five and could not propose. A share recipient's questions are lookups, so theirs stay at five.
 */
const MAX_ROUNDS = 8;
const MAX_ROUNDS_SHARED = 5;
const PER_RESULT = 12_000;
const TOTAL_BUDGET = 120_000;
const SEARCH_LIMIT = 10;
const SERIES_POINTS = 40;
const DEADLINE_MS = 90_000;

/** Every tool the agent has, and whether it only reads. Nothing here writes; a test holds that. */
export const TOOL_KINDS = {
  search_documents: 'read',
  get_document: 'read',
  get_test_series: 'read',
  list_tests: 'read',
  get_connected_documents: 'read',
  get_fields: 'read',
  list_share_links: 'read',
  list_doctors: 'read',
  list_uploads: 'read',
  get_upload: 'read',
  get_regroup_plan: 'read',
  get_results: 'read',
  read_pages: 'read',
  list_suggested_links: 'read',
  get_share_link: 'read',
  list_library: 'read',
  // An action tool prepares a proposal and nothing else (actions.ts); a test holds that the store is not written to.
  propose_share_link: 'action',
  propose_note: 'action',
  propose_edit_document: 'action',
  propose_tags: 'action',
  propose_mark_reviewed: 'action',
  propose_link: 'action',
  propose_merge_doctors: 'action',
  propose_merge_tests: 'action',
  propose_confirm_grouping: 'action',
  propose_reread_pages: 'action',
  propose_analyse_pages: 'action',
  propose_regroup: 'action',
  propose_move_page: 'action',
  propose_rotate_page: 'action',
  propose_hide_page: 'action',
  propose_decide_links: 'action',
  propose_merge_documents: 'action',
  propose_merge_library: 'action',
  propose_update_share: 'action',
  propose_revoke_share: 'action',
} as const satisfies Record<string, 'read' | 'action'>;

/**
 * A question from the recipient of a share link rather than the owner: the documents the link shares, and no others. `userId` is
 * still the owner's (the store needs an acting user), so this is what stands between a recipient and the rest of the archive:
 * every tool that lists, searches or aggregates reads only through it, and a tool that could not be limited this way (the care
 * chain: no share route returns one) is not given to them at all.
 */
interface Scope { docs: Document[]; ids: Set<string> }

/** The documents one question has met, and the labels they were given. */
class Registry {
  private byDoc = new Map<string, string>();
  private byLabel = new Map<string, Document>();
  /** Fields and share links the model has been shown, by the labels it may use to propose a change to them (F3, L2). */
  readonly fieldRefs = new Map<string, { id: string; documentId: string; label: string; value: string }>();
  readonly linkRefs = new Map<string, { id: string; label: string | null; expires_at: string }>();
  readonly doctorRefs = new Map<string, DoctorEntry>();
  /** Results, tags and providers the model has been shown, by label (M3, TG2, PR1), so it can propose changing one. */
  readonly resultRefs = new Map<string, { id: string; documentId: string; name: string; canonical: string; value_text: string; unit: string | null; ref_low: number | null; ref_high: number | null; taken_on: string | null }>();
  readonly tagRefs = new Map<string, { id: number; name: string; count: number }>();
  readonly providerRefs = new Map<string, { name: string; count: number }>();
  /** Groups of a regrouping plan the model was shown (G1), by label. */
  readonly groupRefs = new Map<string, { upload: string; page_ids: string[]; page_numbers: number[]; title: string | null; confidence: number; status: 'validated' | 'uncertain' | 'unchecked'; reason: string; from_documents: string[] }>();
  /** Suggested connections the model has been shown (K1), by label, so it can propose confirming or dismissing them. */
  readonly suggestionRefs = new Map<string, { from: string; to: string; kind: 'requests' | 'follow_up' | 'same_episode'; why: LinkWhy | null }>();
  readonly uploadRefs = new Map<string, { id: string; file_name: string | null; status: string; grouping_confirmed: boolean; uploaded_at: string }>();
  /** Record labels that have been shown to the model (D3, D3.results), the only ones it may cite. */
  readonly shown = new Set<string>();
  label(doc: Document): string {
    let label = this.byDoc.get(doc.id);
    if (!label) { label = `D${this.byDoc.size + 1}`; this.byDoc.set(doc.id, label); this.byLabel.set(label, doc); }
    this.shown.add(label);
    return label;
  }
  get(label: string): Document | undefined { return this.byLabel.get(label.trim().toUpperCase()); }
  labels(): Map<string, string> { return this.byDoc; }
  get size() { return this.byDoc.size; }
  docs() { return this.byLabel; }
}

class Budget {
  left = TOTAL_BUDGET;
  /** The text, cut to what one result may be and to what is left; once nothing is left, a sentence that says so. */
  take(text: string): string {
    if (this.left <= 0) return 'The reading budget for this question is used up. Answer from what you already have.';
    const cut = text.length > Math.min(PER_RESULT, this.left) ? `${text.slice(0, Math.min(PER_RESULT, this.left))}\n… (cut: ask for less at a time)` : text;
    this.left -= cut.length;
    return cut;
  }
}

const head = (doc: Document) => [doc.title, doc.doc_type?.replace(/_/g, ' '), doc.provider, doc.doc_date].filter(Boolean).join(' · ') || 'document';
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);

/**
 * What belongs to one question, kept in the graph's state: the tools and the graph are built once and read it from there.
 * None of it is in a tool's schema, so the model neither sees it nor can write it: it chooses only the arguments of the schema
 * (a query, a label, a test name). `userId` is the one that matters: a tool reads it from here, never from the model.
 */
const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  /** Whose records these are. Set by the route from the session. */
  userId: Annotation<string>(),
  /** The documents this question has met, by the labels it gave them. */
  registry: Annotation<Registry>(),
  budget: Annotation<Budget>(),
  /** What was looked up, in words, for the log of the reply. */
  looked: Annotation<string[]>(),
  /** Where steps and pieces of the answer go, if the caller wants them. */
  progress: Annotation<ChatProgress>(),
  /** Set only for a share recipient's question. Null: the owner's own, over everything shown. */
  scope: Annotation<Scope | null>(),
  /** Changes prepared for the owner to confirm. Nothing in here has been done. */
  proposals: Annotation<Proposal[]>(),
});
type RunState = typeof AgentState.State;

/** The state of the running graph, from the runtime a tool is handed as its second argument. */
const stateOf = (runtime: ToolRuntime): RunState => runtime.state as unknown as RunState;
const UNKNOWN = (label: string) => `There is no document ${label} in this conversation. Search first, then use the labels it returns.`;

/** The tools, defined once. Each reads who is asking, and what this question has seen, from the state of the graph. */
function buildTools(shared: boolean) {

  const searchDocuments = tool(async ({ query, doc_type, date_from, date_to, limit }, runtime: ToolRuntime) => {
    const { userId, registry, budget, looked, progress, scope } = stateOf(runtime);
    const step = (x: ChatStep) => progress?.step?.(x);
    looked.push(`searched “${clip(query, 60)}”`);
    step({ kind: 'search', detail: clip(query, 60) });
    const found = (await documentsForQuestion(userId, query, 40, scope?.ids))
      .filter(d => (!doc_type || d.doc_type === doc_type) && (!date_from || (d.doc_date ?? '') >= date_from) && (!date_to || (d.doc_date ?? '9999') <= date_to))
      .slice(0, limit ?? SEARCH_LIMIT);
    if (found.length === 0) return 'No documents match.';
    return budget.take(found.map(d => `${registry.label(d)}: ${head(d)}${d.ai_summary ? ` — ${clip(d.ai_summary.replace(/\s+/g, ' '), 160)}` : ''}`).join('\n'));
  }, {
    name: 'search_documents',
    description: 'Find the person’s documents by keywords (a test, a diagnosis, a doctor, a clinic, a drug) and, where available, by meaning. Returns labelled one-line descriptions. Use words that would appear in the documents, not a whole sentence. Optionally narrow by type and dates.',
    schema: z.object({
      query: z.string().min(2).max(200).describe('keywords'),
      doc_type: z.enum(['lab_result', 'discharge_note', 'vaccination', 'imaging', 'prescription', 'consultation_note', 'other']).optional(),
      date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
      date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
      limit: z.number().int().min(1).max(SEARCH_LIMIT).optional(),
    }),
  });

  const getDocument = tool(async ({ label, sections }, runtime: ToolRuntime) => {
    const { userId, registry, budget, looked, progress } = stateOf(runtime);
    const step = (x: ChatStep) => progress?.step?.(x);
    const doc = registry.get(label);
    if (!doc) return UNKNOWN(label);
    const wanted = new Set<DocumentSection>(sections?.length ? sections : ['summary', 'notes', 'doctors', 'results']);
    looked.push(`opened ${registry.label(doc)}`);
    step({ kind: 'open', detail: doc.title || head(doc) });
    const records = (await sectionRecords(userId, doc, registry.label(doc), registry.labels())).filter(r => wanted.has(r.label.split('.')[1] as DocumentSection));
    for (const r of records) registry.shown.add(r.label);
    return budget.take(records.length ? records.map(r => `[${r.label}]\n${r.text}`).join('\n\n') : 'That document has nothing in those sections.');
  }, {
    name: 'get_document',
    description: 'Open a document you already have a label for and read parts of it. Sections: summary, notes, doctors, results, fields. Default: summary, notes, doctors and results. Ask for fields only when you need the extracted details.',
    schema: z.object({
      label: z.string().describe('a document label such as D3'),
      sections: z.array(z.enum(['summary', 'notes', 'doctors', 'results', 'fields'])).max(5).optional(),
    }),
  });

  const getTestSeries = tool(async ({ test }, runtime: ToolRuntime) => {
    const { userId, registry, budget, looked, progress, scope } = stateOf(runtime);
    const step = (x: ChatStep) => progress?.step?.(x);
    looked.push(`looked at the values of “${clip(test, 40)}”`);
    step({ kind: 'series', detail: clip(test, 40) });
    const asked = test.trim().toLowerCase();
    const known = scope ? await sharedTestNames(userId, scope.docs) : await getStore().measurements.names(userId);
    const names = known.filter(n => n.canonical.toLowerCase().includes(asked) || n.name.toLowerCase().includes(asked) || asked.includes(n.canonical.toLowerCase()));
    if (names.length === 0) return `No test like “${test}”. Use list_tests to see the names.`;
    const out: string[] = [];
    for (const n of names.slice(0, 3)) {
      const points = (await getStore().measurements.series(userId, n.canonical)).filter(p => !scope || scope.ids.has(p.document_id)).slice(-SERIES_POINTS);
      const lines: string[] = [];
      for (const p of points) {
        const doc = await getStore().documents.findFor(userId, p.document_id);
        lines.push(`${p.taken_on ?? 'undated'}: ${p.value_text}${p.unit ? ` ${p.unit}` : ''}${doc ? ` [${registry.label(doc)}]` : ''}`);
      }
      out.push(`${n.name} (${n.canonical}), oldest first:\n${lines.join('\n')}`);
    }
    return budget.take(out.join('\n\n'));
  }, {
    name: 'get_test_series',
    description: 'The values over time of a test (for example hemoglobin, TSH, ferritin), oldest first, each with the document it came from. Matches by name; if unsure of the name, call list_tests.',
    schema: z.object({ test: z.string().min(2).max(80) }),
  });

  const listTests = tool(async (_input, runtime: ToolRuntime) => {
    const { userId, budget, looked, progress, scope } = stateOf(runtime);
    const step = (x: ChatStep) => progress?.step?.(x);
    looked.push('listed the tests');
    step({ kind: 'tests' });
    const names = scope ? await sharedTestNames(userId, scope.docs) : await getStore().measurements.names(userId);
    if (names.length === 0) return 'No results have been read from any document.';
    return budget.take(names.slice(0, 120).map(n => `${n.name} (${n.canonical}): ${n.count} values, latest ${n.latest_value_text}${n.unit ? ` ${n.unit}` : ''}${n.latest_taken_on ? ` on ${n.latest_taken_on}` : ''}`).join('\n'));
  }, {
    name: 'list_tests',
    description: 'Every test the person has results for, with how many values and the latest one. Use it to find the right name for get_test_series.',
    schema: z.object({}),
  });

  const connected = tool(async ({ label }, runtime: ToolRuntime) => {
    const { userId, registry, budget, looked, progress } = stateOf(runtime);
    const step = (x: ChatStep) => progress?.step?.(x);
    const doc = registry.get(label);
    if (!doc) return UNKNOWN(label);
    looked.push(`followed the connections of ${registry.label(doc)}`);
    step({ kind: 'connections', detail: doc.title || head(doc) });
    const chain = await chainOf(userId, doc.id);
    if (!chain || chain.edges.length === 0) return 'No documents are connected to it.';
    const labelOf = new Map<string, string>();
    for (const n of chain.nodes) {
      const found = n.id === doc.id ? doc : await getStore().documents.findFor(userId, n.id);
      if (found) labelOf.set(n.id, registry.label(found));
    }
    const lines = chain.edges.map(e => {
      const from = labelOf.get(e.from); const to = labelOf.get(e.to);
      if (!from || !to) return null;
      const sentence = e.kind === 'requests' ? `${from} asked for ${to}` : e.kind === 'follow_up' ? `${to} is a follow-up of ${from}` : `${from} and ${to} are one episode`;
      return `${sentence}${e.state === 'proposed' ? ' (suggested by the app, not confirmed)' : ''}`;
    }).filter(Boolean);
    const heads = chain.nodes.map(n => `${labelOf.get(n.id)}: ${[n.title, n.doc_type?.replace(/_/g, ' '), n.doc_date].filter(Boolean).join(' · ')}`);
    return budget.take(`${lines.join('\n')}\n\n${heads.join('\n')}`);
  }, {
    name: 'get_connected_documents',
    description: 'The documents linked to one you have a label for: what asked for it (a consultation that requested these tests), what it asked for, follow-ups and one episode of care.',
    schema: z.object({ label: z.string().describe('a document label such as D3') }),
  });

  // A recipient gets no care chain (links between documents are the owner's, and no share route returns one: M-16) and no tool
  // that proposes a change: they have nothing to change.
  if (shared) return [searchDocuments, getDocument, getTestSeries, listTests];
  const actions = buildActionTools(runtime => stateOf(runtime) as never);
  return [searchDocuments, getDocument, getTestSeries, listTests, connected, ...actions.read, ...actions.action];
}

/** The text of a model reply, whether it came as a string or as parts. */
export function textOf(message: BaseMessage | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : (part as { type?: string; text?: string }).type === 'text' ? (part as { text?: string }).text ?? '' : '')).join('');
  return '';
}

const LABEL = /^D\d+(?:\.[a-z]+)?$/i;

/**
 * A suggestion label (K1) is a handle for proposing a decision, not something an answer can cite. When the model writes one anyway, the
 * citation is the two documents it connects, which are what the person can open; a K label it was never given is dropped.
 */
export function withDocumentLabels(answer: string, registry: { suggestionRefs: Map<string, { from: string; to: string }>; labels(): Map<string, string> }): string {
  return answer.replace(/\s*\[K(\d+)\]/gi, (_whole, n: string) => {
    const ref = registry.suggestionRefs.get(`K${n}`);
    if (!ref) return '';
    const labels = [ref.from, ref.to].map(id => registry.labels().get(id)).filter((l): l is string => !!l);
    return labels.length > 0 ? ` ${labels.map(l => `[${l}]`).join('')}` : '';
  }).replace(/\s*\[(?:F|M|L|P|U|G|TG|PR)\d+\]/g, ''); // the other handles for proposing a change (a field, a result, a link, a doctor, an upload, a group…) are not citations either
}

/** `[D1, D2.results]` becomes `[D1][D2.results]`, so each citation is one marker the page can turn into a link. */
export function splitCitations(answer: string): string {
  return answer.replace(/\[([^\]]+)\]/g, (whole, inner: string) => {
    const parts = inner.split(/[,;\s]+/).filter(Boolean);
    return parts.length > 0 && parts.every(p => LABEL.test(p)) ? parts.map(p => `[${p.toUpperCase().replace(/\.([A-Z]+)$/, (_m, s: string) => `.${s.toLowerCase()}`)}]`).join('') : whole;
  });
}

/**
 * One model call, read as it is written. The text goes to `progress.delta` as it comes, unless the model turns out to be asking
 * for tools: then what was shown is taken back (`reset`), because it was a lead-in and not the answer. A model that cannot
 * stream still works: its whole reply is one piece.
 */
async function callStreaming(model: BaseChatModel, messages: BaseMessage[], progress: ChatProgress): Promise<AIMessage> {
  await spendModelCall(); // the instance's daily allowance (S-35)
  let whole: AIMessageChunk | AIMessage | undefined;
  let tooling = false;
  let shown = false;
  for await (const chunk of await model.stream(messages, { signal: progress.signal })) {
    whole = whole ? (whole as AIMessageChunk).concat(chunk as AIMessageChunk) : chunk;
    if ((chunk as AIMessageChunk).tool_call_chunks?.length || chunk.tool_calls?.length) tooling = true;
    const text = textOf(chunk);
    if (text && !tooling) { progress.delta?.(text); shown = true; }
  }
  if (tooling && shown) progress.reset?.();
  return (whole ?? new AIMessage('')) as AIMessage;
}

const countRounds = (messages: BaseMessage[]) => messages.filter(m => AIMessage.isInstance(m) && (m as AIMessage).tool_calls?.length).length;

/** The agent as a graph: built once for a model and reused, because nothing in it belongs to a question (that is in the state). */
function buildGraph(model: BaseChatModel, shared: boolean) {
  const tools = buildTools(shared);
  const bound = (model as unknown as { bindTools(t: unknown[]): BaseChatModel }).bindTools(tools);
  return new StateGraph(AgentState)
    .addNode('agent', async state => ({ messages: [await callStreaming(bound, state.messages, state.progress)] }))
    .addNode('tools', new ToolNode(tools, { handleToolErrors: true }))
    // The rounds are used up: the pending tool request is dropped and the model is told to answer with what it has.
    .addNode('finish', async state => {
      const messages = state.messages.slice(0, -1);
      return { messages: [await callStreaming(model, [...messages, new HumanMessage('Tools are no longer available. Answer the question now from what you have already read, and say what you could not check.')], state.progress)] };
    })
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', state => {
      const last = state.messages.at(-1);
      if (!last || !AIMessage.isInstance(last) || !(last as AIMessage).tool_calls?.length) return END;
      return countRounds(state.messages) > (shared ? MAX_ROUNDS_SHARED : MAX_ROUNDS) ? 'finish' : 'tools';
    })
    .addEdge('tools', 'agent')
    .addEdge('finish', END)
    .compile();
}
const graphs = new WeakMap<BaseChatModel, { owner?: ReturnType<typeof buildGraph>; shared?: ReturnType<typeof buildGraph> }>();
const graphFor = (model: BaseChatModel, shared: boolean) => {
  const held = graphs.get(model) ?? {};
  graphs.set(model, held);
  const key = shared ? 'shared' : 'owner';
  return (held[key] ??= buildGraph(model, shared));
};

export async function askAgent(model: BaseChatModel, userId: string, question: string, history: ChatTurn[], screen: ScreenContext | null, progress: ChatProgress = {}): Promise<ChatReply | null> {
  const registry = new Registry();
  const budget = new Budget();
  const looked: string[] = [];

  // What is on screen is given up front: the document on screen is D1 and comes in sections.
  const onScreen = await resolveScreen(userId, screen);
  const preload: string[] = [];
  if (onScreen) {
    if (onScreen.primary) registry.label(onScreen.primary);
    for (const doc of onScreen.listed.slice(0, 8)) registry.label(doc);
    preload.push(`[S0]\n${describeScreen(onScreen, registry.labels())}`);
    if (onScreen.listed.length > 0) preload.push(`[S1] documents on screen:\n${onScreen.listed.slice(0, 8).map(d => `${registry.label(d)}: ${head(d)}`).join('\n')}`);
    if (onScreen.upload) {
      registry.uploadRefs.set('U1', { id: onScreen.upload.id, file_name: onScreen.upload.original_filename, status: onScreen.upload.status, grouping_confirmed: onScreen.upload.grouping_confirmed, uploaded_at: onScreen.upload.uploaded_at });
      preload.push('[S2] The upload on screen is U1. Use get_upload to read its documents.');
    }
    if (onScreen.primary) {
      for (const r of await sectionRecords(userId, onScreen.primary, registry.label(onScreen.primary), registry.labels())) { registry.shown.add(r.label); preload.push(`[${r.label}]\n${r.text}`); }
    }
  }

  const messages: BaseMessage[] = [
    new SystemMessage(buildAgentSystemPrompt()),
    ...history.map(t => (t.role === 'user' ? new HumanMessage(t.content) : new AIMessage(t.content))),
    ...(preload.length > 0 ? [new HumanMessage(`What the person has on screen right now:\n\n${preload.join('\n\n')}`)] : []),
    new HumanMessage(`Question: ${question}`),
  ];

  return runGraph(model, false, messages, { userId, registry, budget, looked, progress, scope: null, proposals: [] });
}

interface RunInit { userId: string; registry: Registry; budget: Budget; looked: string[]; progress: ChatProgress; scope: Scope | null; proposals: Proposal[] }

/** Runs the graph and ties the answer's citations back to the documents the model was shown. */
async function runGraph(model: BaseChatModel, shared: boolean, messages: BaseMessage[], init: RunInit): Promise<ChatReply | null> {
  const { registry, looked, progress } = init;
  const result = await graphFor(model, shared).invoke({ messages, ...init }, { recursionLimit: MAX_ROUNDS * 2 + 6, signal: AbortSignal.any([AbortSignal.timeout(DEADLINE_MS), ...(progress.signal ? [progress.signal] : [])]) });
  // A change was prepared but the model said nothing: the card still stands, with a plain line over it.
  const answer = splitCitations(withDocumentLabels(textOf(result.messages.at(-1)).trim(), init.registry)) || (init.proposals.length > 0 ? 'I prepared this for you to confirm.' : '');
  if (!answer) return null;

  // Sources: the labels the answer cites, if they were shown to the model; a section only if that section was.
  const sources: ChatSource[] = [];
  const seen = new Set<string>();
  for (const [, cited] of answer.matchAll(/\[(D\d+(?:\.[a-z]+)?)\]/g)) {
    const [base, section] = cited.split('.');
    const doc = registry.get(base);
    const known = section && (DOCUMENT_SECTIONS as readonly string[]).includes(section) && registry.shown.has(cited) ? (section as DocumentSection) : undefined;
    if (!doc || (section && !known) || seen.has(cited)) continue;
    seen.add(cited);
    sources.push({ label: cited, id: doc.id, title: doc.title, doc_type: doc.doc_type, doc_date: doc.doc_date, ...(known ? { section: known } : {}) });
  }
  return { answer, sources, documents: registry.size, looked, ...(init.proposals.length > 0 ? { proposals: init.proposals } : {}) };
}

/** Owner-chosen text that goes into a prompt as context: one line, no control characters, cut. */
export const promptLabel = (label: string | null): string | null => label?.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/["“”]/g, "'").replace(/\s+/g, ' ').trim().slice(0, 120) || null;

/**
 * A recipient's question about what a link shares. `docs` is what `listForShare` resolved for the link, the one list every
 * tool is held to; `openDocumentId` is the document the recipient has open and is used only if it is in that list.
 */
export async function askSharedAgent(
  model: BaseChatModel,
  owner: string,
  docs: Document[],
  linkLabel: string | null,
  question: string,
  history: ChatTurn[],
  openDocumentId: string | null,
  progress: ChatProgress = {},
): Promise<ChatReply | null> {
  if (docs.length === 0) return { answer: null, sources: [], documents: 0 };
  const scope: Scope = { docs, ids: new Set(docs.map(d => d.id)) };
  const registry = new Registry();
  const preload: string[] = [];

  const open = openDocumentId ? docs.find(d => d.id === openDocumentId) ?? null : null;
  if (open) {
    registry.label(open);
    preload.push(`[S0]\nThe recipient has this shared document open: ${registry.label(open)}. "This document", "here" and "this" mean it.`);
    // Its sections, without the care chain: no share route returns one.
    for (const r of await sectionRecords(owner, open, registry.label(open), registry.labels())) {
      if (r.label.endsWith('.chain')) continue;
      registry.shown.add(r.label);
      preload.push(`[${r.label}]\n${r.text}`);
    }
  }
  // What is shared, so the model knows what exists without searching for it.
  const listed = docs.slice(0, 40);
  preload.push(`[S1] ${tnShared(docs.length)}:\n${listed.map(d => `${registry.label(d)}: ${head(d)}`).join('\n')}${docs.length > listed.length ? `\n… and ${docs.length - listed.length} more (search for them)` : ''}`);

  const messages: BaseMessage[] = [
    new SystemMessage(buildSharedAgentSystemPrompt(promptLabel(linkLabel))),
    ...history.map(t => (t.role === 'user' ? new HumanMessage(t.content) : new AIMessage(t.content))),
    new HumanMessage(`What is shared with the recipient:\n\n${preload.join('\n\n')}`),
    new HumanMessage(`Question: ${question}`),
  ];
  return runGraph(model, true, messages, { userId: owner, registry, budget: new Budget(), looked: [], progress, scope, proposals: [] });
}

const tnShared = (n: number) => (n === 1 ? 'The one document shared' : `The ${n} documents shared`);

/** A cheap check for the caller: is there anything to look at? */
export async function hasAnythingToRead(userId: string, screen: ScreenContext | null): Promise<boolean> {
  const store = getStore();
  if ((await store.documents.listFor(userId, { limit: 1, offset: 0 })).length > 0) return true;
  const onScreen = await resolveScreen(userId, screen);
  return !!onScreen && (!!onScreen.primary || onScreen.facts.length > 0);
}
