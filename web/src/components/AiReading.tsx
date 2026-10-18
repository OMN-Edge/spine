import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, type AiReadingJob } from '../api';
import { loadAiTarget, type AiTarget } from './aiTarget';
import { useI18n } from '../i18n';

/**
 * Reading chosen pages with the model, and extracting the documents they belong to again.
 *
 * A screen wraps what it shows in <AiReadingProvider>, which asks the server whether this is
 * allowed at all and follows the one reading job an upload can have. The <ReadingControl> inside
 * it starts a reading and shares that single poll. Nothing is sent until the person has read what
 * will be sent and where, and pressed the button.
 */

interface AiReadingValue {
  /** Null: the operator has not allowed AI reading, so the buttons do not appear. */
  target: AiTarget | null;
  job: AiReadingJob | null;
  busy: boolean;
  start: (pageIds: string[], model?: string, strategy?: 'model' | 'configured', thinking?: boolean) => Promise<void>;
  dismiss: () => void;
}

const Context = createContext<AiReadingValue>({
  target: null, job: null, busy: false, start: async () => {}, dismiss: () => {},
});
export const useAiReading = () => useContext(Context);

export function AiReadingProvider({
  sourceFileId,
  onFinished,
  children,
}: {
  sourceFileId: string;
  /** Called once a reading ends, so the screen can show what changed. */
  onFinished: () => void;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<AiTarget | null>(null);
  const [job, setJob] = useState<AiReadingJob | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  const follow = useCallback(() => {
    window.clearTimeout(timer.current);
    const tick = () => {
      api.sourceFiles.aiReading(sourceFileId).then(next => {
        if (next.status === 'idle') return setJob(null);
        setJob(next);
        if (next.status === 'running') timer.current = window.setTimeout(tick, 1500);
        else finished.current();
      }).catch(() => { timer.current = window.setTimeout(tick, 4000); });
    };
    tick();
  }, [sourceFileId]);

  useEffect(() => {
    setJob(null);
    loadAiTarget().then(setTarget);
    // A reading started earlier (or on another screen) may still be going.
    api.sourceFiles.aiReading(sourceFileId).then(current => {
      if (current.status === 'running') follow();
    }).catch(() => {});
    return () => window.clearTimeout(timer.current);
  }, [sourceFileId, follow]);

  const start = useCallback(async (pageIds: string[], model?: string, strategy: 'model' | 'configured' = 'model', thinking = false) => {
    setJob(await api.sourceFiles.startAiReading(sourceFileId, pageIds, model, strategy, thinking));
    follow();
  }, [sourceFileId, follow]);

  return (
    <Context.Provider value={{ target, job, busy: job?.status === 'running', start, dismiss: () => setJob(null) }}>
      {children}
    </Context.Provider>
  );
}

/** Progress while a reading runs, and what it did when it ends. */
export function AiReadingBanner({ dark = false }: { dark?: boolean }) {
  const { t, tn } = useI18n();
  const { job, dismiss } = useAiReading();
  if (!job) return null;

  // The server words its progress in English; the steps it can say are known, and a new one shows as it came.
  const stepText = (step: string): string => {
    const page = /^reading page (\d+)$/.exec(step);
    if (page) return t('reading page {n}', { n: page[1] });
    const pages = /^reading (\d+) pages$/.exec(step);
    if (pages) return tn(Number(pages[1]), 'reading {n} page', 'reading {n} pages');
    const documents = /^extracting (\d+) documents again$/.exec(step);
    if (documents) return tn(Number(documents[1]), 'extracting {n} document again', 'extracting {n} documents again');
    switch (step) {
      case 'starting': return t('starting');
      case 'saving the new text': return t('saving the new text');
      case 'extracting the document again': return t('extracting the document again');
      default: return step;
    }
  };

  const base = dark ? 'text-white/90' : 'text-gray-700';
  if (job.status === 'running') {
    return (
      <div role="status" className={`text-sm ${base}`}>
        <p>{t('Reading with AI…')} {stepText(job.step)}</p>
        <div className="h-1 mt-1 rounded-full bg-gray-200/60 overflow-hidden" aria-hidden="true">
          <div className="h-full bg-purple-500 transition-all duration-500 motion-reduce:transition-none" style={{ width: `${job.progress}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div role="status" className={`text-sm ${job.status === 'failed' ? (dark ? 'text-red-300' : 'text-red-600') : base}`}>
      {job.status === 'failed' ? (
        <p>{t('Nothing was changed. The reading did not finish; the server log says why.')}</p>
      ) : (
        <p>
          {tn(job.pages_read, 'Read {n} page.', 'Read {n} pages.')}{' '}
          {job.documents_updated > 0 && <>{tn(job.documents_updated, '{n} document extracted again and waiting in Review.', '{n} documents extracted again and waiting in Review.')} </>}
          {job.documents_not_updated > 0 && (
            <>{tn(job.documents_not_updated, '{n} document could not be extracted again, so its details are from before; try Read again, then Read whole document.', '{n} documents could not be extracted again, so their details are from before; try Read again, then Read whole document.')} </>
          )}
        </p>
      )}
      <button type="button" onClick={dismiss} className={`text-xs underline ${dark ? 'text-white/70' : 'text-gray-500'}`}>{t('Dismiss')}</button>
    </div>
  );
}
