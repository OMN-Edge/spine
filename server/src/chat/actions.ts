import { z } from 'zod';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { getStore } from '../store/index.js';
import { cleanTag } from '../tags.js';
import { getMailer } from '../mail/index.js';
import { SUPPORTED_LANGUAGES } from '../languages.js';
import { DOC_TYPES } from '../llm/types.js';
import { aiReadingAllowed, getParser } from '../parser/index.js';
import { checkDetails, checkTags, LIMITS } from '../routes/documents.js';
import { normaliseLicenseCode, suggestDuplicates } from '../doctors.js';
import { validWhen } from '../ingestion/measurements.js';
import type { Document } from '../types.js';
import type { RegroupPlan } from '../regroup/analyze.js';
import { getRegroupJob } from '../regroup/jobs.js';
import type { ChatProgress, ChatStep } from './index.js';
import { MAX_BULK, MAX_GROUPS, MAX_PROPOSALS, MAX_SHARED_DOCUMENTS, proposal, refOf, type DetailChange, type DoctorEntry, type LibraryEntry, type Proposal, type ProposedCall, type TestEntry } from './proposals.js';

/**
 * The tools that prepare a change, and the two read tools they need (a document's fields, the owner's share links).
 *
 * **None of these changes anything.** A `propose_*` tool checks its arguments against the same limits as the route Confirm will
 * call, resolves labels the request itself handed out (a label is the only way the model names a thing: never an id), and puts a
 * `Proposal` in the state; the reply carries it to the page, where the person confirms or cancels. A test holds that no store
 * method that writes is called while the agent runs. Security-relevant options of a share (scans, approval, questions) are not
 * arguments here: the card shows them and the person decides.
 *
 * Only the owner's agent is given these. A share recipient's agent is built without them (`buildTools(shared)`).
 */

/** What these tools need from the question they run in. The agent's own state satisfies it. */
export interface ActionState {
  userId: string;
  registry: {
    get(label: string): Document | undefined;
    label(doc: Document): string;
    fieldRefs: Map<string, { id: string; documentId: string; label: string; value: string }>;
    resultRefs: Map<string, { id: string; documentId: string; name: string; canonical: string; value_text: string; unit: string | null; ref_low: number | null; ref_high: number | null; taken_on: string | null }>;
    tagRefs: Map<string, { id: number; name: string; count: number }>;
    providerRefs: Map<string, { name: string; count: number }>;
    linkRefs: Map<string, { id: string; label: string | null; expires_at: string }>;
    doctorRefs: Map<string, DoctorEntry>;
    uploadRefs: Map<string, { id: string; file_name: string | null; status: string; grouping_confirmed: boolean; uploaded_at: string }>;
    groupRefs: Map<string, { upload: string; page_ids: string[]; page_numbers: number[]; title: string | null; confidence: number; status: 'validated' | 'uncertain' | 'unchecked'; reason: string; from_documents: string[] }>;
  };
  budget: { take(text: string): string };
  proposals: Proposal[];
  looked: string[];
  progress: ChatProgress;
}

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);
const named = (d: Document) => d.title || [d.doc_type?.replace(/_/g, ' '), d.provider, d.doc_date].filter(Boolean).join(' · ') || 'document';
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

const RECORDED = (n: number) =>
  `Proposal ${n} is recorded. The person will see it as a card with Confirm and Cancel; nothing has been changed and nothing will be until they confirm. ` +
  'Do not say it is done. Say in a sentence or two what you proposed, and that they need to confirm it.';
const UNKNOWN = (label: string) => `There is no document ${label} in this conversation. Search first, then use the labels it returns.`;

export function buildActionTools(stateOf: (runtime: ToolRuntime) => ActionState) {
  const step = (s: ActionState, x: ChatStep) => s.progress?.step?.(x);

  /** Records a proposal if there is room; the text for the model either way. */
  const record = (s: ActionState, made: Proposal): string => {
    if (s.proposals.length >= MAX_PROPOSALS) return `At most ${MAX_PROPOSALS} proposals can be made for one question. Tell the person what is left to do and let them ask again.`;
    s.proposals.push(made);
    s.looked.push('prepared a change for the person to confirm');
    step(s, { kind: 'propose' });
    return RECORDED(s.proposals.length);
  };

  /**
   * Documents from labels: the ones this request gave and that are still the person's, and the labels that were not. A share
   * needs them *shown* as well (`shown`): a document of an upload still waiting for its grouping to be confirmed can be corrected
   * from here, but it cannot be shared, because no share reads it.
   */
  const resolve = async (s: ActionState, labels: string[], shown = false): Promise<{ docs: Document[]; unknown: string[] }> => {
    const found: Document[] = [];
    const unknown: string[] = [];
    for (const label of labels) {
      const doc = s.registry.get(label);
      if (!doc) unknown.push(label); else if (!found.some(d => d.id === doc.id)) found.push(doc);
    }
    const store = getStore();
    const allowed = shown
      ? new Set((await store.documents.listShownByIds(s.userId, found.map(d => d.id))).map(d => d.id))
      : new Set((await Promise.all(found.map(d => store.documents.findFor(s.userId, d.id)))).filter((d): d is Document => !!d).map(d => d.id));
    return { docs: found.filter(d => allowed.has(d.id)), unknown: [...unknown, ...found.filter(d => !allowed.has(d.id)).map(d => s.registry.label(d))] };
  };

  // --- reading what the proposals need -------------------------------------------------------------------------------

  const getFields = tool(async ({ label }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    const doc = s.registry.get(label);
    if (!doc) return UNKNOWN(label);
    s.looked.push(`read the fields of ${s.registry.label(doc)}`);
    step(s, { kind: 'fields', detail: named(doc) });
    const fields = (await getStore().fields.listForDocument(s.userId, doc.id)).slice(0, 80);
    if (fields.length === 0) return 'That document has no extracted fields.';
    return s.budget.take(fields.map(f => {
      const ref = [...s.registry.fieldRefs.entries()].find(([, v]) => v.id === f.id)?.[0] ?? `F${s.registry.fieldRefs.size + 1}`;
      s.registry.fieldRefs.set(ref, { id: f.id, documentId: doc.id, label: f.label, value: f.value });
      return `${ref}: ${f.label.replace(/_/g, ' ')}: ${clip(oneLine(f.value), 300)}`;
    }).join('\n'));
  }, {
    name: 'get_fields',
    description: 'The extracted fields of a document you have a label for, each with a label such as F3. Use it before proposing to change or remove a field: you refer to a field by that label.',
    schema: z.object({ label: z.string().describe('a document label such as D3') }),
  });

  const listShareLinks = tool(async (_input, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    s.looked.push('listed the share links');
    step(s, { kind: 'shares' });
    const links = await getStore().shareLinks.listFor(s.userId);
    if (links.length === 0) return 'The person has made no share links.';
    const now = Date.now();
    return s.budget.take(links.slice(0, 40).map((l, i) => {
      const ref = `L${i + 1}`;
      s.registry.linkRefs.set(ref, { id: l.id, label: l.label, expires_at: l.expires_at });
      let scope = l.scope as string;
      try {
        const value = l.scope_value ? JSON.parse(l.scope_value) : null;
        scope = l.scope === 'document_ids' ? `${Array.isArray(value) ? value.length : 0} documents` : l.scope === 'tag' ? `tag ${String(value)}` : l.scope === 'date_range' ? `${value?.from}–${value?.to}` : 'all history';
      } catch { /* shown as its kind */ }
      const state = l.revoked ? 'revoked' : new Date(l.expires_at).getTime() < now ? 'expired' : 'active';
      return `${ref}: ${l.label ? `“${clip(oneLine(l.label), 80)}”, ` : ''}${scope}, ${state}, expires ${l.expires_at.slice(0, 10)}, ${l.view_count} views${l.include_scans ? ', with scans' : ''}${l.require_approval ? ', needs approval' : ''}`;
    }).join('\n'));
  }, {
    name: 'list_share_links',
    description: 'The share links the person has made, each with a label such as L2: what it shares, whether it is active, when it expires and how often it was opened. Use it to find a link to revoke.',
    schema: z.object({}),
  });

  const listDoctors = tool(async (_input, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    s.looked.push('listed the doctors');
    step(s, { kind: 'doctors' });
    const doctors = (await getStore().doctors.listFor(s.userId)).slice(0, 200);
    if (doctors.length === 0) return 'The directory has no doctors.';
    const ref = new Map<string, string>();
    doctors.forEach((d, i) => {
      const label = `P${i + 1}`;
      ref.set(d.id, label);
      s.registry.doctorRefs.set(label, { id: d.id, name: d.name, specialty: d.specialty, clinic: d.clinic, license_code: d.license_code, document_count: d.document_count });
    });
    const lines = doctors.map(d => `${ref.get(d.id)}: ${d.name}${d.specialty ? `, ${d.specialty}` : ''}${d.clinic ? `, ${d.clinic}` : ''} — ${d.license_code ? `code ${d.license_code}` : 'no code'}, ${d.document_count} documents`);
    // The app's own guess, from the names alone; the model may find more (a different capitalization, a missing code, an initial).
    const guesses = suggestDuplicates(doctors).map(({ keep, other }) => `${ref.get(keep.id)} and ${ref.get(other.id)}`);
    return s.budget.take(`${lines.join('\n')}${guesses.length > 0 ? `\n\nThe app thinks these may be one person: ${guesses.join('; ')}.` : ''}`);
  }, {
    name: 'list_doctors',
    description: 'The doctors in the person’s directory, each with a label such as P3, their specialty, clinic, professional code and how many documents name them. Use it to find entries that are one person written several ways, before proposing to merge them.',
    schema: z.object({}),
  });

  const listUploads = tool(async (_input, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    s.looked.push('listed the uploads');
    step(s, { kind: 'uploads' });
    const uploads = (await getStore().sourceFiles.listFor(s.userId)).slice(0, 10);
    if (uploads.length === 0) return 'The person has made no uploads.';
    return s.budget.take(uploads.map((u, i) => {
      const label = `U${i + 1}`;
      s.registry.uploadRefs.set(label, { id: u.id, file_name: u.original_filename, status: u.status, grouping_confirmed: u.grouping_confirmed, uploaded_at: u.uploaded_at });
      return `${label}: ${u.original_filename ? `“${clip(u.original_filename, 60)}”, ` : ''}${u.uploaded_at.slice(0, 10)}, ${u.status}${u.status === 'done' ? (u.grouping_confirmed ? ', grouping confirmed' : ', grouping NOT yet confirmed') : ''}`;
    }).join('\n'));
  }, {
    name: 'list_uploads',
    description: 'The person’s recent uploads, each with a label such as U2, its date, whether it has been read and whether they have confirmed how its pages were grouped. Use it to find the upload they mean.',
    schema: z.object({}),
  });

  const getUpload = tool(async ({ upload }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    const held = s.registry.uploadRefs.get(upload.trim().toUpperCase());
    if (!held) return `There is no upload ${upload} in this conversation. Call list_uploads first.`;
    s.looked.push(`opened the upload ${upload}`);
    step(s, { kind: 'uploads', detail: held.file_name ?? held.uploaded_at.slice(0, 10) });
    const store = getStore();
    // The one place the documents of an upload still waiting for its grouping to be confirmed reach the assistant: the person is
    // checking exactly these, and asked about this upload.
    const docs = (await store.documents.listFor(s.userId, { sourceFileId: held.id, includeUnconfirmed: true, limit: 200, offset: 0 })).sort((a, b) => a.page_start - b.page_start);
    const pages = await store.pages.listForSourceFile(s.userId, held.id);
    const unread = pages.filter(p => !p.hidden && !p.raw_text?.trim()).map(p => p.page_number);
    const lines = docs.map(d => `${s.registry.label(d)}: pages ${d.page_start}-${d.page_end}, ${named(d)}${d.doc_type ? ` (${d.doc_type.replace(/_/g, ' ')})` : ''}${d.doc_date ? `, ${d.doc_date}` : ', NO DATE'}${d.reviewed ? ', reviewed' : ''}`);
    return s.budget.take([
      `${upload}: ${held.file_name ? `“${clip(held.file_name, 60)}”, ` : ''}${held.status}, ${pages.length} pages, ${held.grouping_confirmed ? 'grouping confirmed' : 'grouping NOT yet confirmed (its documents are out of the timeline and search until it is)'}`,
      lines.length ? `Documents:\n${lines.join('\n')}` : 'No documents.',
      unread.length ? `Pages with no text read from them: ${unread.slice(0, 40).join(', ')}.` : 'Every page has text.',
    ].join('\n'));
  }, {
    name: 'get_upload',
    description: 'One upload with its documents (each gets a label such as D4 you can then open or change), their page ranges, types and dates, and which pages had no text. Use it to check what an upload became.',
    schema: z.object({ upload: z.string().describe('an upload label such as U1') }),
  });

  const getRegroupPlan = tool(async ({ upload }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    const held = s.registry.uploadRefs.get(upload.trim().toUpperCase());
    if (!held) return `There is no upload ${upload} in this conversation. Call list_uploads first.`;
    s.looked.push(`read the regrouping plan of ${upload}`);
    step(s, { kind: 'plan' });
    const store = getStore();
    const job = getRegroupJob(held.id);
    if (job?.status === 'running') return `The analysis of ${upload} is still running (${job.step}). Tell the person it is not ready; they will get a message when it is.`;
    const saved = await store.regroupPlans.get(s.userId, held.id);
    if (!saved) return `There is no analysis of ${upload}. If the person wants the pages sorted out, propose one with propose_analyse_pages.`;
    const plan = saved.plan as RegroupPlan;
    const docs = await store.documents.listFor(s.userId, { sourceFileId: held.id, includeUnconfirmed: true, limit: 200, offset: 0 });
    const docById = new Map(docs.map(d => [d.id, d]));
    const lines = plan.groups.map((g, i) => {
      const label = `G${i + 1}`;
      s.registry.groupRefs.set(label, { upload: held.id, page_ids: g.page_ids, page_numbers: g.page_numbers, title: g.title, confidence: g.confidence, status: g.status, reason: g.reason, from_documents: g.from_documents });
      const from = g.from_documents.map(id => docById.get(id)).filter((d): d is Document => !!d).map(d => `${s.registry.label(d)} “${clip(named(d), 40)}”`).join(', ');
      return `${label}: pages ${g.page_numbers.join(', ')} — ${g.status}${g.status === 'unchecked' ? ' (the model gave no verdict)' : ` (${g.confidence})`}${g.title ? `, “${clip(g.title, 60)}”` : ''}; now in ${from || 'no document'}${g.reason ? `; ${clip(g.reason, 160)}` : ''}`;
    });
    return s.budget.take([
      `${upload}: analysed ${saved.created_at.slice(0, 16).replace('T', ' ')}: ${plan.pages_considered} pages with text, ${plan.pages_unreadable} without (left where they are); ${plan.groups.length} group(s) would change the grouping, ${plan.unchanged_groups} already hold together; ${plan.model_calls} model checks; embeddings ${plan.embeddings ? 'used' : 'not used'}.`,
      lines.length ? lines.join('\n') : 'Nothing would change.',
      'Pages not in a group stay where they are. A group the model validated holds together on its own evidence; an uncertain or unchecked one is a guess.',
    ].join('\n'));
  }, {
    name: 'get_regroup_plan',
    description: 'What the analysis of a mixed upload found: groups of pages (labels G1, G2…) that belong together, with the model’s verdict, a title and why, and the documents the pages are in now. Read it before proposing to regroup, and tell the person what you would change.',
    schema: z.object({ upload: z.string().describe('an upload label such as U1') }),
  });

  const getResults = tool(async ({ label }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    const doc = s.registry.get(label);
    if (!doc) return UNKNOWN(label);
    s.looked.push(`read the results of ${s.registry.label(doc)}`);
    step(s, { kind: 'fields', detail: named(doc) });
    const results = (await getStore().measurements.listForDocument(s.userId, doc.id)).slice(0, 80);
    if (results.length === 0) return 'That document has no results.';
    return s.budget.take(results.map(m => {
      const ref = [...s.registry.resultRefs.entries()].find(([, v]) => v.id === m.id)?.[0] ?? `M${s.registry.resultRefs.size + 1}`;
      s.registry.resultRefs.set(ref, { id: m.id, documentId: doc.id, name: m.name, canonical: m.canonical, value_text: m.value_text, unit: m.unit, ref_low: m.ref_low, ref_high: m.ref_high, taken_on: m.taken_on });
      return `${ref}: ${m.name}: ${m.value_text}${m.unit ? ` ${m.unit}` : ''}${m.ref_low !== null && m.ref_high !== null ? ` (reference ${m.ref_low}–${m.ref_high})` : ''}${m.flag ? ` ${m.flag}` : ''}${m.taken_on ? `, ${m.taken_on}` : ''}`;
    }).join('\n'));
  }, {
    name: 'get_results',
    description: 'The results (tests with a value) of a document you have a label for, each with a label such as M3. Use it before proposing to change or remove a result: you refer to a result by that label.',
    schema: z.object({ label: z.string().describe('a document label such as D3') }),
  });

  const getShareLink = tool(async ({ link }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    const held = s.registry.linkRefs.get(link.trim().toUpperCase());
    if (!held) return `There is no share link ${link} in this conversation. Call list_share_links first.`;
    s.looked.push(`opened the share link ${link}`);
    step(s, { kind: 'shares' });
    const store = getStore();
    const row = await store.shareLinks.findFor(s.userId, held.id);
    if (!row) return `There is no share link ${link}.`;
    let docs: Document[] = [];
    try {
      docs = await store.documents.listForShare({ id: row.id, userId: s.userId, scope: row.scope, scopeValue: row.scope_value, expiresAt: row.expires_at, includeScans: row.include_scans, language: row.language, requireApproval: row.require_approval, allowChat: row.allow_chat });
    } catch { /* a scope that cannot be read shares nothing */ }
    return s.budget.take([
      `${link}: ${row.label ? `“${clip(oneLine(row.label), 80)}”, ` : ''}${row.revoked ? 'revoked' : new Date(row.expires_at).getTime() < Date.now() ? 'expired' : 'active'}, expires ${row.expires_at.slice(0, 10)}, ${row.view_count} views${row.include_scans ? ', with scans' : ''}${row.require_approval ? ', needs approval' : ''}${row.allow_chat ? ', recipient may ask questions' : ''}`,
      docs.length ? `It shares:\n${docs.slice(0, 100).map(d => `${s.registry.label(d)}: ${named(d)}${d.doc_date ? ` (${d.doc_date})` : ''}`).join('\n')}` : 'It shares no documents.',
    ].join('\n'));
  }, {
    name: 'get_share_link',
    description: 'One share link: its settings and the documents it shares now, each with a label such as D4. Use it before proposing to change which documents a link shares.',
    schema: z.object({ link: z.string().describe('a link label such as L2') }),
  });

  const listLibrary = tool(async (_input, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    s.looked.push('listed the tags and providers');
    step(s, { kind: 'library' });
    const store = getStore();
    const tags = (await store.tags.listWithCounts(s.userId)).slice(0, 150);
    const providers = (await store.documents.providers(s.userId)).slice(0, 150);
    const tagLines = tags.map((t, i) => {
      const label = `TG${i + 1}`;
      s.registry.tagRefs.set(label, { id: t.id, name: t.name, count: t.document_count });
      return `${label}: ${t.name} (${t.document_count})`;
    });
    const providerLines = providers.map((p, i) => {
      const label = `PR${i + 1}`;
      s.registry.providerRefs.set(label, { name: p.name, count: p.document_count });
      return `${label}: ${p.name} (${p.document_count})`;
    });
    return s.budget.take([`Tags:\n${tagLines.join('\n') || '(none)'}`, `Providers (the clinic or laboratory on documents):\n${providerLines.join('\n') || '(none)'}`].join('\n\n'));
  }, {
    name: 'list_library',
    description: 'The person’s tags (labels such as TG3) and providers (labels such as PR2), each with how many documents carry it. Use it to find entries that are one thing written several ways, before proposing to merge them.',
    schema: z.object({}),
  });

  // --- proposing -----------------------------------------------------------------------------------------------------

  const proposeShare = tool(async ({ documents, label, expires_days, language }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    const { docs, unknown } = await resolve(s, documents, true);
    if (unknown.length > 0) return `${unknown.map(UNKNOWN).join('\n')}\nNothing was proposed.`;
    if (docs.length === 0) return 'No documents to share. Nothing was proposed.';
    if (docs.length > MAX_SHARED_DOCUMENTS) return `A share can name at most ${MAX_SHARED_DOCUMENTS} documents; propose fewer, or ask the person which matter most.`;
    return record(s, proposal({
      kind: 'share_link',
      documents: docs.map(refOf),
      label: label ? oneLine(label).slice(0, 80) : null,
      expires_days: expires_days ?? 7,
      language: language ?? null,
      // The person's to decide, on the card. Approval starts on when the owner can be told by mail, which is what makes it usable.
      require_approval: getMailer().enabled,
      include_scans: false,
      allow_chat: false,
      approval_mail: getMailer().enabled,
    }));
  }, {
    name: 'propose_share_link',
    description:
      'Prepare a share link for the person to confirm. Name the documents it shares by their labels (at most 30): exactly the ones that serve the purpose, not the whole archive. ' +
      'The person can still remove documents and choose scans, approval and questions on the card, so do not try to set them. Give a short label saying whom or what it is for.',
    schema: z.object({
      documents: z.array(z.string()).min(1).max(MAX_SHARED_DOCUMENTS).describe('document labels such as D3'),
      label: z.string().max(80).optional().describe('for whom or what, e.g. “Cardiology follow-up”'),
      expires_days: z.number().int().min(1).max(30).optional().describe('default 7'),
      language: z.enum(SUPPORTED_LANGUAGES as unknown as [string, ...string[]]).optional().describe('the language the recipient’s page opens in, if the person asked for one'),
    }),
  });

  const proposeNote = tool(async ({ document, text }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    const { docs, unknown } = await resolve(s, [document]);
    if (unknown.length > 0 || docs.length === 0) return UNKNOWN(document);
    const doc = docs[0];
    const added = text.trim();
    if (!added) return 'The note is empty. Nothing was proposed.';
    const notes = doc.user_notes?.trimEnd() ? `${doc.user_notes.trimEnd()}\n\n${added}` : added;
    const problem = checkDetails({ user_notes: notes });
    if (problem) return `${problem}. Nothing was proposed.`;
    return record(s, proposal({
      kind: 'add_note', document: refOf(doc), text: added,
      calls: [{ method: 'PATCH', path: `/api/documents/${doc.id}`, body: { user_notes: notes } }],
    }));
  }, {
    name: 'propose_note',
    description: 'Prepare a note (a comment) to add after the person’s existing notes on a document. Write it as the person would, in their language, from what they asked you to note. Do not put in anything they did not say.',
    schema: z.object({ document: z.string().describe('a document label such as D3'), text: z.string().min(1).max(2000) }),
  });

  const proposeEdit = tool(async ({ document, title, doc_date, provider, doc_type, field_updates, field_adds, field_removes, result_updates, result_adds, result_removes }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    const { docs, unknown } = await resolve(s, [document]);
    if (unknown.length > 0 || docs.length === 0) return UNKNOWN(document);
    const doc = docs[0];

    const patch: Record<string, unknown> = {};
    const changes: DetailChange[] = [];
    const headline: Array<['title' | 'doc_date' | 'provider' | 'doc_type', string | undefined]> = [['title', title], ['doc_date', doc_date], ['provider', provider], ['doc_type', doc_type]];
    for (const [what, to] of headline) {
      if (to === undefined) continue;
      const from = (doc[what] as string | null | undefined) ?? null;
      const next = to.trim() === '' ? null : to.trim();
      if (next === from) continue;
      patch[what] = next ?? '';
      changes.push({ what, from, to: next });
    }
    const problem = checkDetails(patch);
    if (problem) return `${problem}. Nothing was proposed.`;

    const fieldEdits: { update: Array<{ id: string; label: string; value: string }>; remove: string[]; add: Array<{ label: string; value: string; page_id: string }> } = { update: [], remove: [], add: [] };
    const own = (ref: string) => {
      const f = s.registry.fieldRefs.get(ref.trim().toUpperCase());
      return f && f.documentId === doc.id ? f : null;
    };
    for (const u of field_updates ?? []) {
      const f = own(u.field);
      if (!f) return `There is no field ${u.field} on ${s.registry.label(doc)}. Call get_fields first. Nothing was proposed.`;
      const value = u.value.trim();
      const label = (u.label ?? f.label).trim();
      if (value === f.value && label === f.label) continue;
      if (!value || value.length > LIMITS.value || !label || label.length > LIMITS.label) return 'A field value or label is empty or too long. Nothing was proposed.';
      fieldEdits.update.push({ id: f.id, label, value });
      changes.push({ what: 'field_update', label: f.label, from: f.value, to: value });
    }
    for (const ref of field_removes ?? []) {
      const f = own(ref);
      if (!f) return `There is no field ${ref} on ${s.registry.label(doc)}. Call get_fields first. Nothing was proposed.`;
      if (fieldEdits.update.some(x => x.id === f.id) || fieldEdits.remove.includes(f.id)) return `Field ${ref} is changed or removed twice. Nothing was proposed.`;
      fieldEdits.remove.push(f.id);
      changes.push({ what: 'field_remove', label: f.label, from: f.value });
    }
    if ((field_adds ?? []).length > 0) {
      // A new field sits on the document's first page: the person can see and move on from there.
      const page = (await getStore().pages.listForDocument(s.userId, doc.id))[0];
      if (!page) return 'That document has no page to put a new field on. Nothing was proposed.';
      for (const a of field_adds ?? []) {
        const label = a.label.trim(); const value = a.value.trim();
        if (!label || label.length > LIMITS.label || !value || value.length > LIMITS.value) return 'A new field needs a label and a value of reasonable length. Nothing was proposed.';
        fieldEdits.add.push({ label, value, page_id: page.id });
        changes.push({ what: 'field_add', label, to: value });
      }
    }
    if (fieldEdits.update.length + fieldEdits.remove.length + fieldEdits.add.length > 0) patch.fields = fieldEdits;

    // Results (measurements): the number, unit, range and date of a value. The route works the flag out again from value and range.
    const shownResult = (r: { value_text: string; unit: string | null; ref_low: number | null; ref_high: number | null; taken_on: string | null }) =>
      `${r.value_text}${r.unit ? ` ${r.unit}` : ''}${r.ref_low !== null && r.ref_high !== null ? ` (${r.ref_low}–${r.ref_high})` : ''}${r.taken_on ? `, ${r.taken_on}` : ''}`;
    const ownResult = (ref: string) => {
      const r = s.registry.resultRefs.get(ref.trim().toUpperCase());
      return r && r.documentId === doc.id ? r : null;
    };
    const numberOrNull = (v: number | null | undefined, keep: number | null) => (v === undefined ? keep : v);
    const resultEdits: { update: Array<Record<string, unknown>>; remove: string[]; add: Array<Record<string, unknown>> } = { update: [], remove: [], add: [] };
    for (const u of result_updates ?? []) {
      const r = ownResult(u.result);
      if (!r) return `There is no result ${u.result} on ${s.registry.label(doc)}. Call get_results first. Nothing was proposed.`;
      const next = {
        value_text: u.value?.trim() || r.value_text, unit: u.unit === undefined ? r.unit : u.unit.trim() || null,
        ref_low: numberOrNull(u.ref_low, r.ref_low), ref_high: numberOrNull(u.ref_high, r.ref_high),
        taken_on: u.taken_on === undefined ? r.taken_on : u.taken_on.trim() || null,
      };
      const name = u.name?.trim() || r.name;
      if (JSON.stringify(next) === JSON.stringify({ value_text: r.value_text, unit: r.unit, ref_low: r.ref_low, ref_high: r.ref_high, taken_on: r.taken_on }) && name === r.name) continue;
      if (next.value_text.length > LIMITS.measurementValue || name.length > LIMITS.label) return 'A result’s name or value is too long. Nothing was proposed.';
      if (next.taken_on && validWhen(next.taken_on) === null) return 'A result’s date must be a real day (YYYY-MM-DD) or month (YYYY-MM). Nothing was proposed.';
      resultEdits.update.push({ id: r.id, name, canonical: name === r.name ? r.canonical : undefined, value: next.value_text, unit: next.unit, ref_low: next.ref_low, ref_high: next.ref_high, taken_on: next.taken_on });
      changes.push({ what: 'result_update', name: r.name, from: shownResult(r), to: shownResult(next) });
    }
    for (const ref of result_removes ?? []) {
      const r = ownResult(ref);
      if (!r) return `There is no result ${ref} on ${s.registry.label(doc)}. Call get_results first. Nothing was proposed.`;
      if (resultEdits.update.some(x => x.id === r.id) || resultEdits.remove.includes(r.id)) return `Result ${ref} is changed or removed twice. Nothing was proposed.`;
      resultEdits.remove.push(r.id);
      changes.push({ what: 'result_remove', name: r.name, from: shownResult(r) });
    }
    if ((result_adds ?? []).length > 0) {
      const page = (await getStore().pages.listForDocument(s.userId, doc.id))[0];
      if (!page) return 'That document has no page to put a new result on. Nothing was proposed.';
      for (const a of result_adds ?? []) {
        const name = a.name.trim(); const value = a.value.trim();
        if (!name || name.length > LIMITS.label || !value || value.length > LIMITS.measurementValue) return 'A new result needs a name and a value of reasonable length. Nothing was proposed.';
        if (a.taken_on && validWhen(a.taken_on) === null) return 'A result’s date must be a real day (YYYY-MM-DD) or month (YYYY-MM). Nothing was proposed.';
        const item = { value_text: value, unit: a.unit?.trim() || null, ref_low: a.ref_low ?? null, ref_high: a.ref_high ?? null, taken_on: a.taken_on?.trim() || doc.doc_date };
        resultEdits.add.push({ name, value, unit: item.unit, ref_low: item.ref_low, ref_high: item.ref_high, taken_on: item.taken_on, page_id: page.id });
        changes.push({ what: 'result_add', name, to: shownResult(item) });
      }
    }
    if (resultEdits.update.length + resultEdits.remove.length + resultEdits.add.length > 0) patch.measurements = resultEdits;

    if (changes.length === 0) return 'Nothing would change: the document already has these values.';
    return record(s, proposal({
      kind: 'edit_document', document: refOf(doc), changes,
      calls: [{ method: 'PATCH', path: `/api/documents/${doc.id}`, body: patch }],
    }));
  }, {
    name: 'propose_edit_document',
    description:
      'Prepare a correction to a document for the person to confirm: its title, date (YYYY-MM-DD), provider or type, and its extracted fields (change, add or remove, by the F-labels from get_fields). ' +
      'Its results (the tests with a value): change a value, unit, reference range or date, add or remove one, by the M-labels from get_results. ' +
      'Change only what the person asked. To correct a field or a result, read the document’s fields (get_fields) or results (get_results) first.',
    schema: z.object({
      document: z.string().describe('a document label such as D3'),
      title: z.string().max(LIMITS.title).optional(),
      doc_date: z.string().max(10).optional().describe('YYYY-MM-DD, or empty to clear'),
      provider: z.string().max(LIMITS.provider).optional(),
      doc_type: z.enum(DOC_TYPES as unknown as [string, ...string[]]).optional(),
      field_updates: z.array(z.object({ field: z.string(), value: z.string(), label: z.string().optional() })).max(20).optional(),
      field_adds: z.array(z.object({ label: z.string(), value: z.string() })).max(10).optional(),
      field_removes: z.array(z.string()).max(20).optional(),
      result_updates: z.array(z.object({
        result: z.string().describe('a result label such as M3, from get_results'),
        name: z.string().optional(), value: z.string().optional(), unit: z.string().optional(),
        ref_low: z.number().nullable().optional(), ref_high: z.number().nullable().optional(), taken_on: z.string().optional().describe('YYYY-MM-DD or YYYY-MM'),
      })).max(20).optional(),
      result_adds: z.array(z.object({
        name: z.string(), value: z.string(), unit: z.string().optional(), ref_low: z.number().nullable().optional(), ref_high: z.number().nullable().optional(), taken_on: z.string().optional(),
      })).max(10).optional(),
      result_removes: z.array(z.string()).max(20).optional(),
    }),
  });

  const proposeTags = tool(async ({ changes }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    if (changes.length > MAX_BULK) return `At most ${MAX_BULK} documents at a time. Nothing was proposed.`;
    const items: Array<{ document: ReturnType<typeof refOf>; add: string[]; remove: string[] }> = [];
    const calls: ProposedCall[] = [];
    for (const change of changes) {
      const { docs, unknown } = await resolve(s, [change.document]);
      if (unknown.length > 0 || docs.length === 0) return UNKNOWN(change.document);
      const doc = docs[0];
      const add = [...new Set((change.add ?? []).map(cleanTag).filter((t): t is string => !!t))];
      const remove = [...new Set((change.remove ?? []).map(cleanTag).filter((t): t is string => !!t))];
      const current = await getStore().tags.namesForDocument(s.userId, doc.id);
      const next = [...current.filter(t => !remove.includes(t)), ...add.filter(t => !current.includes(t))];
      const added = add.filter(t => !current.includes(t));
      const removed = remove.filter(t => current.includes(t));
      if (added.length === 0 && removed.length === 0) continue;
      const bad = checkTags(next);
      if (bad) return `${bad}. Nothing was proposed.`;
      items.push({ document: refOf(doc), add: added, remove: removed });
      calls.push({ method: 'PATCH', path: `/api/documents/${doc.id}`, body: { tags: next } });
    }
    if (items.length === 0) return 'Nothing would change: the documents already have those tags.';
    return record(s, proposal({ kind: 'tag_documents', items, calls }));
  }, {
    name: 'propose_tags',
    description: 'Prepare tags to add to or remove from documents (up to 20), for the person to confirm. A tag is a short lower-case word; prefer tags the person already uses.',
    schema: z.object({
      changes: z.array(z.object({ document: z.string(), add: z.array(z.string().max(LIMITS.tag)).max(10).optional(), remove: z.array(z.string().max(LIMITS.tag)).max(10).optional() })).min(1).max(MAX_BULK),
    }),
  });

  const proposeReviewed = tool(async ({ documents }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    const { docs, unknown } = await resolve(s, documents);
    if (unknown.length > 0) return unknown.map(UNKNOWN).join('\n');
    const todo = docs.filter(d => !d.reviewed);
    if (todo.length === 0) return 'Those documents are already marked reviewed.';
    return record(s, proposal({
      kind: 'mark_reviewed', documents: todo.map(refOf),
      calls: todo.map(d => ({ method: 'PATCH' as const, path: `/api/documents/${d.id}`, body: { reviewed: true } })),
    }));
  }, {
    name: 'propose_mark_reviewed',
    description: 'Prepare marking documents as reviewed (the person has checked what was read from them), for the person to confirm. Only when they ask.',
    schema: z.object({ documents: z.array(z.string()).min(1).max(MAX_BULK) }),
  });

  const proposeMergeDoctors = tool(async ({ groups }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    if (groups.length > MAX_GROUPS) return `At most ${MAX_GROUPS} groups at a time. Nothing was proposed.`;
    const used = new Set<string>();
    const out: Array<{ keep: DoctorEntry; merge: DoctorEntry[]; final: { name: string; specialty: string | null; clinic: string | null; license_code: string | null } }> = [];
    for (const g of groups) {
      const keep = s.registry.doctorRefs.get(g.keep.trim().toUpperCase());
      const merge = g.merge.map(l => s.registry.doctorRefs.get(l.trim().toUpperCase()));
      if (!keep || merge.some(m => !m)) return `Some doctor labels are unknown (${[g.keep, ...g.merge].join(', ')}). Call list_doctors first and use its labels. Nothing was proposed.`;
      const members = merge as DoctorEntry[];
      const all = [keep, ...members];
      if (new Set(all.map(d => d.id)).size !== all.length) return 'A doctor is named twice in a group. Nothing was proposed.';
      if (all.some(d => used.has(d.id))) return 'A doctor is in two groups. Nothing was proposed.';
      all.forEach(d => used.add(d.id));
      // A professional code names one person: two different codes are two people, whatever the names look like.
      const codes = new Set(all.map(d => d.license_code).filter((c): c is string => !!c));
      if (codes.size > 1) return `${all.map(d => d.name).join(' / ')} carry different professional codes (${[...codes].join(', ')}): they are different people. Nothing was proposed.`;
      // The final form starts from what the model proposes, then from what the entries already know, the fuller one first.
      const pick = (given: string | undefined, key: 'specialty' | 'clinic' | 'license_code') => (given?.trim() ? given.trim() : all.map(d => d[key]).find(v => !!v) ?? null);
      const name = (g.name?.trim() || keep.name).replace(/\s+/g, ' ');
      if (!name || name.length > 120) return 'A doctor’s name is 1 to 120 characters. Nothing was proposed.';
      const code = g.license_code?.trim() ? normaliseLicenseCode(g.license_code) : pick(undefined, 'license_code');
      if (g.license_code?.trim() && !code) return 'A professional code is at least 4 letters or digits. Nothing was proposed.';
      out.push({ keep, merge: members, final: { name, specialty: pick(g.specialty, 'specialty'), clinic: pick(g.clinic, 'clinic'), license_code: code } });
    }
    if (out.length === 0) return 'Nothing to merge.';
    return record(s, proposal({ kind: 'merge_doctors', groups: out }));
  }, {
    name: 'propose_merge_doctors',
    description:
      'Prepare merging directory entries that are one person written several ways (different capitalization, an initial, a missing code), for the person to confirm. Each group names the entry to keep and the entries to fold into it, by P-labels from list_doctors, ' +
      'and the final form: name, specialty, clinic and professional code, written once and fully (the fullest correct spelling). Leave a field out to use what the entries already hold. Never group two entries with different codes, or people who only share a surname.',
    schema: z.object({
      groups: z.array(z.object({
        keep: z.string().describe('the label of the entry that stays, such as P3'),
        merge: z.array(z.string()).min(1).max(10).describe('labels of the entries folded into it'),
        name: z.string().max(120).optional(), specialty: z.string().max(80).optional(), clinic: z.string().max(120).optional(), license_code: z.string().max(24).optional(),
      })).min(1).max(MAX_GROUPS),
    }),
  });

  const proposeMergeTests = tool(async ({ groups }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    if (groups.length > MAX_GROUPS) return `At most ${MAX_GROUPS} groups at a time. Nothing was proposed.`;
    const store = getStore();
    const known = new Map((await store.measurements.names(s.userId)).map(n => [n.canonical.toLowerCase(), n]));
    const entry = async (canonical: string): Promise<TestEntry | null> => {
      const n = known.get(canonical.trim().toLowerCase());
      if (!n) return null;
      const units = [...new Set((await store.measurements.series(s.userId, n.canonical)).map(p => p.unit?.trim()).filter((u): u is string => !!u))].slice(0, 6);
      return { canonical: n.canonical, name: n.name, count: n.count, units };
    };
    const used = new Set<string>();
    const out: Array<{ into: TestEntry; from: TestEntry[]; final_name: string }> = [];
    for (const g of groups) {
      const into = await entry(g.into);
      const from = await Promise.all(g.merge.map(entry));
      if (!into || from.some(f => !f)) return `Some test names are not in the person’s results (${[g.into, ...g.merge].join(', ')}). Call list_tests and use its names exactly. Nothing was proposed.`;
      const members = from as TestEntry[];
      const all = [into, ...members];
      if (new Set(all.map(t => t.canonical)).size !== all.length) return 'A test is named twice in a group. Nothing was proposed.';
      if (all.some(t => used.has(t.canonical))) return 'A test is in two groups. Nothing was proposed.';
      all.forEach(t => used.add(t.canonical));
      const finalName = (g.name?.trim() || into.canonical).replace(/\s+/g, ' ');
      if (!finalName || finalName.length > 120) return 'A test name is 1 to 120 characters. Nothing was proposed.';
      out.push({ into, from: members, final_name: finalName });
    }
    return record(s, proposal({ kind: 'merge_tests', groups: out }));
  }, {
    name: 'propose_merge_tests',
    description:
      'Prepare merging names of the same test (for example Hb, Hemoglobin and HGB; ferritin and feritina), for the person to confirm. Each group names the test to keep and the tests folded into it, exactly as list_tests prints them, and the final name written once. ' +
      'Group only names for the same measurement: the same test in a different unit is shown to the person as a warning, but do not group different measurements.',
    schema: z.object({
      groups: z.array(z.object({ into: z.string(), merge: z.array(z.string()).min(1).max(10), name: z.string().max(120).optional().describe('the final name; default: the kept test’s') })).min(1).max(MAX_GROUPS),
    }),
  });

  const proposeConfirmGrouping = tool(async ({ upload }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    const held = s.registry.uploadRefs.get(upload.trim().toUpperCase());
    if (!held) return `There is no upload ${upload} in this conversation. Call list_uploads first.`;
    const store = getStore();
    const file = await store.sourceFiles.findFor(s.userId, held.id);
    if (!file) return `There is no upload ${upload}.`;
    if (file.status !== 'done') return 'That upload has not finished being read. Nothing was proposed.';
    if (file.grouping_confirmed) return 'That upload’s grouping is already confirmed.';
    const docs = (await store.documents.listFor(s.userId, { sourceFileId: file.id, includeUnconfirmed: true, limit: 200, offset: 0 })).sort((a, b) => a.page_start - b.page_start);
    return record(s, proposal({
      kind: 'confirm_grouping', upload: { id: file.id, file_name: file.original_filename, uploaded_at: file.uploaded_at }, documents: docs.map(refOf),
      calls: [{ method: 'POST', path: `/api/source-files/${file.id}/grouping/confirm` }],
    }));
  }, {
    name: 'propose_confirm_grouping',
    description: 'Prepare confirming how an upload’s pages were grouped into documents, for the person to confirm. Until they do, its documents are out of the timeline, search and shares. Only when they say the grouping is right.',
    schema: z.object({ upload: z.string().describe('an upload label such as U1') }),
  });

  const proposeAnalyse = tool(async ({ upload }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    const held = s.registry.uploadRefs.get(upload.trim().toUpperCase());
    if (!held) return `There is no upload ${upload} in this conversation. Call list_uploads first.`;
    const store = getStore();
    const file = await store.sourceFiles.findFor(s.userId, held.id);
    if (!file) return `There is no upload ${upload}.`;
    if (file.status !== 'done') return 'That upload has not finished being read. Nothing was proposed.';
    if (getRegroupJob(file.id)?.status === 'running') return 'An analysis of that upload is already running. Nothing was proposed.';
    const pages = (await store.pages.listForSourceFile(s.userId, file.id)).filter(p => !p.hidden && (p.raw_text ?? '').trim().length >= 40);
    if (pages.length < 2) return 'That upload has fewer than two pages with text to sort. Nothing was proposed.';
    return record(s, proposal({
      kind: 'analyse_pages', upload: { id: file.id, file_name: file.original_filename, uploaded_at: file.uploaded_at }, pages: pages.length,
      calls: [{ method: 'POST', path: `/api/source-files/${file.id}/regroup/analyze` }],
    }));
  }, {
    name: 'propose_analyse_pages',
    description:
      'Prepare an analysis of a mixed upload (a bulk export whose pages come from several documents, in no order) to find which pages belong together, for the person to confirm. It compares the pages\' text, then asks the AI model to check each candidate group. ' +
      'It changes nothing and runs in the background; the person gets a message when the plan is ready. Use it when they say pages are mixed up or ask you to sort an upload out.',
    schema: z.object({ upload: z.string().describe('an upload label such as U1') }),
  });

  const proposeRegroupGroups = tool(async ({ upload, groups }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    const held = s.registry.uploadRefs.get(upload.trim().toUpperCase());
    if (!held) return `There is no upload ${upload} in this conversation. Call list_uploads first.`;
    const store = getStore();
    const file = await store.sourceFiles.findFor(s.userId, held.id);
    if (!file || file.status !== 'done') return 'That upload has not finished being read. Nothing was proposed.';
    const chosen = groups.map(l => ({ label: l.trim().toUpperCase(), ref: s.registry.groupRefs.get(l.trim().toUpperCase()) }));
    const missing = chosen.filter(c => !c.ref || c.ref.upload !== held.id).map(c => c.label);
    if (missing.length > 0) return `No group ${missing.join(', ')} for ${upload}. Call get_regroup_plan and use its labels. Nothing was proposed.`;
    if (chosen.length > MAX_GROUPS * 3) return 'Too many groups at once. Nothing was proposed.';
    // The plan was made from the pages as they were: each page must still be in this upload, and no page in two groups.
    const here = new Set((await store.pages.listForSourceFile(s.userId, held.id)).map(p => p.id));
    const seen = new Set<string>();
    for (const c of chosen) for (const id of c.ref!.page_ids) {
      if (!here.has(id)) return 'The plan is out of date: its pages are not this upload’s any more. Propose a new analysis. Nothing was proposed.';
      if (seen.has(id)) return 'A page is in two of those groups. Nothing was proposed.';
      seen.add(id);
    }
    const docs = new Map((await store.documents.listFor(s.userId, { sourceFileId: held.id, includeUnconfirmed: true, limit: 200, offset: 0 })).map(d => [d.id, d]));
    return record(s, proposal({
      kind: 'regroup', upload: { id: held.id, file_name: held.file_name },
      groups: chosen.map(c => ({
        label: c.label, page_ids: c.ref!.page_ids, page_numbers: c.ref!.page_numbers, title: c.ref!.title, confidence: c.ref!.confidence, status: c.ref!.status, reason: c.ref!.reason,
        from: c.ref!.from_documents.map(id => docs.get(id)).filter((d): d is Document => !!d).map(refOf),
      })),
    }));
  }, {
    name: 'propose_regroup',
    description:
      'Prepare regrouping an upload\'s pages into the groups of its analysis (labels from get_regroup_plan), for the person to confirm. The card shows each new document with its pages, the model\'s verdict and reason, and lets the person keep or drop each group and each page. ' +
      'Include the groups the model validated unless the person says otherwise; include an uncertain or unchecked group only if they ask. Pages not in a group stay where they are. The documents that change are read again afterwards.',
    schema: z.object({ upload: z.string().describe('an upload label such as U1'), groups: z.array(z.string()).min(1).max(MAX_GROUPS * 3).describe('group labels such as G1') }),
  });

  const proposeReread = tool(async ({ document, pages, whole }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    const { docs, unknown } = await resolve(s, [document]);
    if (unknown.length > 0 || docs.length === 0) return UNKNOWN(document);
    const doc = docs[0];
    const store = getStore();
    const file = await store.sourceFiles.findFor(s.userId, doc.source_file_id);
    if (!file) return UNKNOWN(document);
    if (file.status !== 'done') return 'That document’s file is still being processed. Nothing was proposed.';
    const shown = await store.pages.listForDocument(s.userId, doc.id);
    const strategy = whole ? 'configured' as const : 'model' as const;
    const chosen = whole ? shown : shown.filter(p => (pages ?? []).includes(p.page_number));
    if (chosen.length === 0) return `Name page numbers of that document (${shown.map(p => p.page_number).join(', ')}), or whole: true. Nothing was proposed.`;
    if (chosen.length > 200) return 'Too many pages at once. Nothing was proposed.';
    // The same switch as the route: an image goes to the model provider only if the operator allowed it.
    const sendsImages = strategy === 'model' || !!file.mime_type?.startsWith('image/') || getParser().imageEgress;
    if (sendsImages && !aiReadingAllowed()) return 'Reading pages with AI is not enabled on this server. Nothing was proposed.';
    return record(s, proposal({
      kind: 'reread_pages', document: refOf(doc), page_numbers: chosen.map(p => p.page_number), strategy, sends_images: sendsImages,
      calls: [{ method: 'POST', path: `/api/source-files/${file.id}/ai-reading`, body: { page_ids: chosen.map(p => p.id), strategy } }],
    }));
  }, {
    name: 'propose_reread_pages',
    description:
      'Prepare reading page(s) of a document again, for the person to confirm. With page numbers (the file’s numbering, as the screen gives it): each page’s image is sent to the AI model to be read, then the document is extracted again. ' +
      'With whole: true: all the document’s pages are read again the way an upload reads them. Use when the person says a page was misread or has no text. The person’s edits are kept.',
    schema: z.object({
      document: z.string().describe('a document label such as D3'),
      pages: z.array(z.number().int().min(1)).max(50).optional().describe('page numbers of the file'),
      whole: z.boolean().optional(),
    }),
  });

  const proposeMergeLibrary = tool(async ({ library, groups }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    if (groups.length > MAX_GROUPS) return `At most ${MAX_GROUPS} groups at a time. Nothing was proposed.`;
    const used = new Set<string>();
    const out: Array<{ keep: LibraryEntry; merge: LibraryEntry[]; final_name: string }> = [];
    const entry = (label: string): LibraryEntry | null => {
      const key = label.trim().toUpperCase();
      if (library === 'tags') { const t = s.registry.tagRefs.get(key); return t ? { id: t.id, name: t.name, count: t.count } : null; }
      const p = s.registry.providerRefs.get(key);
      return p ? { id: null, name: p.name, count: p.count } : null;
    };
    for (const g of groups) {
      const keep = entry(g.keep);
      const merge = g.merge.map(entry);
      if (!keep || merge.some(m => !m)) return `Some labels are unknown (${[g.keep, ...g.merge].join(', ')}). Call list_library first and use its labels. Nothing was proposed.`;
      const all = [keep, ...(merge as LibraryEntry[])];
      const keys = all.map(e => (library === 'tags' ? String(e.id) : e.name));
      if (new Set(keys).size !== keys.length) return 'An entry is named twice in a group. Nothing was proposed.';
      if (keys.some(k => used.has(k))) return 'An entry is in two groups. Nothing was proposed.';
      keys.forEach(k => used.add(k));
      const raw = (g.name?.trim() || keep.name).replace(/\s+/g, ' ');
      const finalName = library === 'tags' ? cleanTag(raw) : raw;
      if (!finalName || finalName.length > (library === 'tags' ? LIMITS.tag : LIMITS.provider)) return `A ${library === 'tags' ? 'tag' : 'provider'} name is not valid or too long. Nothing was proposed.`;
      out.push({ keep, merge: merge as LibraryEntry[], final_name: finalName });
    }
    return record(s, proposal({ kind: 'merge_library', library, groups: out }));
  }, {
    name: 'propose_merge_library',
    description:
      'Prepare merging tags, or providers (the clinic or laboratory names on documents), that are one thing written several ways (capitalization, an abbreviation, a typo), for the person to confirm. Each group names the entry to keep and the entries folded into it by the labels from list_library, ' +
      'and the final name written once. The documents keep everything else. Group only entries that mean the same.',
    schema: z.object({
      library: z.enum(['tags', 'providers']),
      groups: z.array(z.object({ keep: z.string(), merge: z.array(z.string()).min(1).max(10), name: z.string().max(200).optional().describe('the final name; default: the kept entry’s') })).min(1).max(MAX_GROUPS),
    }),
  });

  const proposeUpdateShare = tool(async ({ link, label, expires_days, add_documents, remove_documents }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    const held = s.registry.linkRefs.get(link.trim().toUpperCase());
    if (!held) return `There is no share link ${link} in this conversation. Call list_share_links first.`;
    const store = getStore();
    const row = await store.shareLinks.findFor(s.userId, held.id);
    if (!row) return `There is no share link ${link}.`;
    if (row.revoked) return 'That link is revoked and cannot be changed. Nothing was proposed.';

    const body: Record<string, unknown> = {};
    let labelChange: { from: string | null; to: string | null } | null = null;
    if (label !== undefined) {
      const next = oneLine(label).slice(0, 80) || null;
      if (next !== row.label) { body.label = next; labelChange = { from: row.label, to: next }; }
    }
    let expires: { from: string; to_days: number } | null = null;
    if (expires_days !== undefined) { body.expires_days = expires_days; expires = { from: row.expires_at, to_days: expires_days }; }

    let added: Document[] = []; let removed: Document[] = []; let totalAfter: number | null = null;
    if ((add_documents ?? []).length + (remove_documents ?? []).length > 0) {
      let current: Document[] = [];
      try {
        current = await store.documents.listForShare({ id: row.id, userId: s.userId, scope: row.scope, scopeValue: row.scope_value, expiresAt: row.expires_at, includeScans: row.include_scans, language: row.language, requireApproval: row.require_approval, allowChat: row.allow_chat });
      } catch { /* a scope that cannot be read shares nothing, so there is nothing to remove */ }
      const currentIds = new Set(current.map(d => d.id));
      const add = await resolve(s, add_documents ?? [], true);
      const gone = await resolve(s, remove_documents ?? []);
      if (add.unknown.length + gone.unknown.length > 0) return `${[...add.unknown, ...gone.unknown].map(UNKNOWN).join('\n')}\nNothing was proposed.`;
      added = add.docs.filter(d => !currentIds.has(d.id));
      removed = gone.docs.filter(d => currentIds.has(d.id));
      const next = [...current.filter(d => !removed.some(r => r.id === d.id)), ...added];
      if (next.length === 0) return 'That would leave the link sharing nothing. Revoke it instead. Nothing was proposed.';
      if (next.length > 100) return 'A link can share at most 100 documents here. Nothing was proposed.';
      if (added.length + removed.length > 0) { body.scope = 'document_ids'; body.scope_value = next.map(d => d.id); totalAfter = next.length; }
    }
    if (Object.keys(body).length === 0) return 'Nothing would change.';
    return record(s, proposal({
      kind: 'update_share', link: { id: row.id, label: row.label, expires_at: row.expires_at },
      label: labelChange, expires, added: added.map(refOf), removed: removed.map(refOf), total_after: totalAfter,
      calls: [{ method: 'PATCH', path: `/api/share-links/${row.id}`, body }],
    }));
  }, {
    name: 'propose_update_share',
    description:
      'Prepare a change to a share link that already exists, for the person to confirm: its name, how long it works (days from now), and which documents it shares (add or remove by document labels; read the current ones with get_share_link). ' +
      'You cannot change what it exposes (scans, approval, recipient questions): the person does that on the link’s page. A revoked link cannot be changed.',
    schema: z.object({
      link: z.string().describe('a link label such as L2'),
      label: z.string().max(80).optional(),
      expires_days: z.number().int().min(1).max(30).optional().describe('works until this many days from now'),
      add_documents: z.array(z.string()).max(50).optional(),
      remove_documents: z.array(z.string()).max(50).optional(),
    }),
  });

  const proposeLink = tool(async ({ from, to, kind }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    const { docs, unknown } = await resolve(s, [from, to]);
    if (unknown.length > 0 || docs.length !== 2) return `Both documents must be ones you have labels for and that are different. ${unknown.map(UNKNOWN).join(' ')}`.trim();
    const [a, b] = [s.registry.get(from)!, s.registry.get(to)!];
    // Earlier to later, as the links are kept: a request or a follow-up that runs backwards in time is a mistake.
    if (kind !== 'same_episode' && a.doc_date && b.doc_date && a.doc_date > b.doc_date) return `${from} is dated after ${to}: "from" is the earlier document (the one that asked, or the visit followed up). Swap them or check the dates. Nothing was proposed.`;
    return record(s, proposal({
      kind: 'link_documents', from: refOf(a), to: refOf(b), link_kind: kind,
      calls: [{ method: 'POST', path: '/api/document-links', body: { from: a.id, to: b.id, kind } }],
    }));
  }, {
    name: 'propose_link',
    description: 'Prepare a connection between two documents for the person to confirm: `requests` (from is the consultation that asked for the tests in to), `follow_up` (to follows up from) or `same_episode`. From is the earlier one.',
    schema: z.object({ from: z.string(), to: z.string(), kind: z.enum(['requests', 'follow_up', 'same_episode']) }),
  });

  const proposeRevoke = tool(async ({ link }, runtime: ToolRuntime) => {
    const s = stateOf(runtime);
    const held = s.registry.linkRefs.get(link.trim().toUpperCase());
    if (!held) return `There is no share link ${link} in this conversation. Call list_share_links first.`;
    return record(s, proposal({
      kind: 'revoke_share', link: { id: held.id, label: held.label, expires_at: held.expires_at },
      calls: [{ method: 'DELETE', path: `/api/share-links/${held.id}` }],
    }));
  }, {
    name: 'propose_revoke_share',
    description: 'Prepare revoking one of the person’s share links (it stops working at once), for them to confirm. Find its label with list_share_links.',
    schema: z.object({ link: z.string().describe('a link label such as L2') }),
  });

  return {
    read: [getFields, getResults, listShareLinks, getShareLink, listDoctors, listLibrary, listUploads, getUpload, getRegroupPlan],
    action: [proposeMergeLibrary, proposeUpdateShare, proposeShare, proposeNote, proposeEdit, proposeTags, proposeReviewed, proposeLink, proposeMergeDoctors, proposeMergeTests, proposeConfirmGrouping, proposeAnalyse, proposeRegroupGroups, proposeReread, proposeRevoke],
  };
}

export { named as documentName };
