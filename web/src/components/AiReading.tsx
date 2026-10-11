import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, type AiReadingJob } from '../api';
import { loadAiTarget, whereTo, type AiTarget } from './aiTarget';

/**
 * Reading chosen pages with the model, and extracting the documents they belong to again.
 *
 * A screen wraps what it shows in <AiReadingProvider>, which asks the server whether this is
 * allowed at all and follows the one reading job an upload can have. Any number of
 * <AiReadButton>s then sit inside it (one per document, one in the page preview) and share
 * that single poll. Nothing is sent until the person has read what will be sent and where,
 * and confirmed.
 */

interface AiReadingValue {
  /** Null: the operator has not allowed AI reading, so the buttons do not appear. */
  target: AiTarget | null;
  job: AiReadingJob | null;
  busy: boolean;
  start: (pageIds: string[]) => Promise<void>;
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

  const start = useCallback(async (pageIds: string[]) => {
    setJob(await api.sourceFiles.startAiReading(sourceFileId, pageIds));
    follow();
  }, [sourceFileId, follow]);

  return (
    <Context.Provider value={{ target, job, busy: job?.status === 'running', start, dismiss: () => setJob(null) }}>
      {children}
    </Context.Provider>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * "Read this page / these pages with AI". Asks first: how many images go where, which
 * documents will be extracted again, and what that replaces.
 */
export function AiReadButton({
  pageIds,
  label,
  documents,
  reviewed,
  className = '',
  dark = false,
}: {
  pageIds: string[];
  label: string;
  /** On the dark page preview. */
  dark?: boolean;
  /** How many documents contain these pages: what gets extracted again. */
  documents: number;
  /** Of those, how many the owner has already reviewed (their edits would be replaced). */
  reviewed: number;
  className?: string;
}) {
  const { target, busy, start } = useAiReading();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  if (!target || pageIds.length === 0) return null;

  const send = async () => {
    setError('');
    try {
      await start(pageIds);
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start');
    }
  };

  return (
    <div className={className}>
      {!confirming ? (
        <button
          type="button" disabled={busy} onClick={() => setConfirming(true)}
          className={`text-sm disabled:opacity-40 ${dark ? 'text-purple-300 hover:text-purple-200' : 'text-purple-700 hover:text-purple-900'}`}
        >
          {label}
        </button>
      ) : (
        <div className="rounded-lg border border-purple-200 bg-purple-50 p-3 text-left">
          <p className="text-sm text-gray-800">
            This sends {plural(pageIds.length, 'page image', 'page images')} to <strong>{whereTo(target)}</strong> and
            reads {pageIds.length === 1 ? 'it' : 'them'} again.
          </p>
          <p className="text-xs text-gray-600 mt-1">
            {documents > 0
              ? `It then extracts ${plural(documents, 'document', 'documents')} again: title, date, provider, type, summary, tags and fields are replaced, and ${documents === 1 ? 'it goes' : 'they go'} back to Review. Your notes are kept.`
              : 'These pages are not part of any document, so only their text changes.'}
            {reviewed > 0 && ` You have already reviewed ${reviewed === documents && documents === 1 ? 'it' : plural(reviewed, 'of them', 'of them')}; your edits to ${reviewed === 1 ? 'it' : 'those'} will be replaced.`}
          </p>
          {error && <p role="alert" className="text-xs text-red-600 mt-2">{error}</p>}
          <div className="flex gap-2 mt-2">
            <button type="button" onClick={send} className="text-sm bg-purple-600 text-white rounded-lg px-3 py-1.5 hover:bg-purple-700">
              Send and read
            </button>
            <button type="button" onClick={() => { setConfirming(false); setError(''); }} className="text-sm text-gray-500 hover:text-gray-700 px-2">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Progress while a reading runs, and what it did when it ends. */
export function AiReadingBanner({ dark = false }: { dark?: boolean }) {
  const { job, dismiss } = useAiReading();
  if (!job) return null;

  const base = dark ? 'text-white/90' : 'text-gray-700';
  if (job.status === 'running') {
    return (
      <div role="status" className={`text-sm ${base}`}>
        <p>Reading with AI… {job.step}</p>
        <div className="h-1 mt-1 rounded-full bg-gray-200/60 overflow-hidden" aria-hidden="true">
          <div className="h-full bg-purple-500 transition-all duration-500 motion-reduce:transition-none" style={{ width: `${job.progress}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div role="status" className={`text-sm ${job.status === 'failed' ? (dark ? 'text-red-300' : 'text-red-600') : base}`}>
      {job.status === 'failed' ? (
        <p>Nothing was changed. {job.error ?? 'The reading did not finish.'}</p>
      ) : (
        <p>
          Read {plural(job.pages_read, 'page', 'pages')}.{' '}
          {job.documents_updated > 0 && <>{plural(job.documents_updated, 'document', 'documents')} extracted again and waiting in Review. </>}
          {job.documents_not_updated > 0 && (
            <>{plural(job.documents_not_updated, 'document', 'documents')} could not be extracted again, so {job.documents_not_updated === 1 ? 'its' : 'their'} details are from before; try “Extract details again”. </>
          )}
        </p>
      )}
      <button type="button" onClick={dismiss} className={`text-xs underline ${dark ? 'text-white/70' : 'text-gray-500'}`}>Dismiss</button>
    </div>
  );
}

/**
 * "Extract details again": the same extraction an upload does, on the page text already
 * read. No image is sent, so it needs no switch and works wherever the model does.
 */
export function ExtractAgainButton({
  documentId,
  reviewed,
  onDone,
  className = '',
}: {
  documentId: string;
  reviewed: boolean;
  onDone: (result: 'done' | 'failed') => void;
  className?: string;
}) {
  const { busy } = useAiReading();
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setWorking(true);
    setError('');
    try {
      const { reread } = await api.documents.reextract(documentId);
      setConfirming(false);
      onDone(reread);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not extract again');
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className={className}>
      {!confirming ? (
        <button type="button" disabled={busy} onClick={() => setConfirming(true)} className="text-sm text-blue-600 hover:underline disabled:opacity-40">
          Extract details again
        </button>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <p className="text-xs text-gray-600">
            Reads the text already on the pages again. Nothing leaves this server except the text, as at upload. The title, date, provider,
            type, summary, tags and fields are replaced and the document goes back to Review. Your notes are kept.
            {reviewed && ' You have reviewed it; your edits will be replaced.'}
          </p>
          {error && <p role="alert" className="text-xs text-red-600 mt-2">{error}</p>}
          <div className="flex gap-2 mt-2">
            <button type="button" disabled={working} onClick={run} className="text-sm bg-blue-600 text-white rounded-lg px-3 py-1.5 hover:bg-blue-700 disabled:opacity-50">
              {working ? 'Extracting…' : 'Extract again'}
            </button>
            <button type="button" disabled={working} onClick={() => { setConfirming(false); setError(''); }} className="text-sm text-gray-500 hover:text-gray-700 px-2">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
