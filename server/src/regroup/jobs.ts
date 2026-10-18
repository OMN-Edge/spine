import { getStore } from '../store/index.js';
import { getChatLlm } from '../llm/index.js';
import { getEmbedder } from '../embedding/index.js';
import { llmContextChars } from '../config.js';
import { logger } from '../logger.js';
import { describeError } from '../failure.js';
import { announceRegroupLater } from '../chat/notices.js';
import { planRegrouping, type RegroupPlan } from './analyze.js';

/**
 * The analysis of a mixed upload runs in the background (a model call per group, tens of seconds for a bulk export), as reading
 * pages again does: the owner confirms it, it runs, the plan is kept, and the app starts a conversation when it is ready. The state
 * of a run is in memory; the plan it produces is stored (`regroup_plans`).
 */
export interface RegroupJob {
  status: 'running' | 'done' | 'failed';
  step: string;
  progress: number;
  started_at: string;
  finished_at?: string;
}

const jobs = new Map<string, RegroupJob>();

export const getRegroupJob = (sourceFileId: string): RegroupJob | null => jobs.get(sourceFileId) ?? null;
export const isAnalysingPages = (sourceFileId: string): boolean => jobs.get(sourceFileId)?.status === 'running';
export function resetRegroupJobs(): void { jobs.clear(); }

/** Embeddings of page text, in batches, or null when they are off. */
async function embedPages(texts: string[]): Promise<Float32Array[]> {
  const embedder = getEmbedder();
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 16) out.push(...await embedder.embed(texts.slice(i, i + 16), 'document'));
  return out;
}

export function startRegroupAnalysis(userId: string, sourceFileId: string): RegroupJob {
  const running = jobs.get(sourceFileId);
  if (running?.status === 'running') return running;
  const job: RegroupJob = { status: 'running', step: 'reading the pages', progress: 0, started_at: new Date().toISOString() };
  jobs.set(sourceFileId, job);

  void (async () => {
    try {
      const store = getStore();
      const pages = await store.pages.listForSourceFile(userId, sourceFileId);
      const documents = (await store.documents.listFor(userId, { sourceFileId, limit: 1000, offset: 0, includeHidden: true, includeUnconfirmed: true }))
        .sort((a, b) => a.page_start - b.page_start)
        .map(d => ({ id: d.id, page_ids: pages.filter(p => p.page_number >= d.page_start && p.page_number <= d.page_end).map(p => p.id) }));
      job.step = 'finding which pages belong together';
      const llm = getChatLlm();
      const plan: RegroupPlan = await planRegrouping(
        pages.map(p => ({ id: p.id, page_number: p.page_number, raw_text: p.raw_text, hidden: p.hidden })),
        documents,
        pageTexts => llm.judgeGrouping(pageTexts),
        getEmbedder().enabled ? embedPages : null,
        {
          // The model is shown a share of the context for each page of a group, never more than a page or so of text.
          pageChars: Math.max(500, Math.min(1500, Math.floor(llmContextChars() / 40))),
          progress: (done, total) => { job.progress = Math.round((done / Math.max(1, total)) * 100); job.step = `checking groups (${done} of ${total})`; },
        },
      );
      await store.regroupPlans.save(userId, sourceFileId, plan, plan.created_at);
      job.status = 'done'; job.progress = 100; job.step = 'ready'; job.finished_at = new Date().toISOString();
      // Counts only, no page text: tuning the thresholds is done from these.
      logger.info('regrouping analysed', { sourceFileId, pages: plan.pages_considered, unreadable: plan.pages_unreadable, proposed: plan.groups.length, unchanged: plan.unchanged_groups, calls: plan.model_calls, embeddings: plan.embeddings });
      announceRegroupLater(userId, sourceFileId);
    } catch (err) {
      logger.warn('regrouping analysis failed', { sourceFileId, error: describeError(err) });
      job.status = 'failed'; job.step = 'failed'; job.finished_at = new Date().toISOString();
    }
  })();
  return job;
}
