import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AttachedFile } from '../api';
import { msg, useI18n } from '../i18n';

/**
 * Files the person attached, as they are in their message: what became of each, and while one is being read, how far it has got
 * (the same status the Upload page shows). When one finishes, `onSettled` is called so the conversation is read again and the app's
 * report of it appears below. Nothing here reads the file; the upload route has.
 */
const SKIPPED: Record<string, string> = {
  not_pdf: msg('Not a PDF, photo or zip of them.'),
  photo_needs_ai: msg('A photo has to be read by the AI model, which is switched off on this server.'),
  too_large: msg('Too large.'),
  zip_unreadable: msg('The zip could not be opened.'),
};

function Progress({ file, onSettled }: { file: AttachedFile; onSettled: () => void }) {
  const { t } = useI18n();
  const [state, setState] = useState<{ status: string; progress: number; step: string } | null>(null);
  const settled = useRef(false);

  useEffect(() => {
    if (!file.upload_id) return;
    let live = true;
    let timer: number | undefined;
    const poll = () => api.sourceFiles.status(file.upload_id!).then(s => {
      if (!live) return;
      // A one-page upload is read as soon as its pages are: "done" with `reading` is not finished yet, and its report comes after.
      const finished = s.status === 'error' || (s.status === 'done' && !s.reading);
      setState({ status: finished || s.status !== 'done' ? s.status : 'processing', progress: s.progress, step: s.step });
      if (finished) {
        if (!settled.current) { settled.current = true; onSettled(); }
      } else timer = window.setTimeout(poll, 2000);
    }).catch(() => { if (live) timer = window.setTimeout(poll, 5000); });
    void poll();
    return () => { live = false; window.clearTimeout(timer); };
  // The poll runs for the life of the message; `onSettled` is stable enough for one call.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.upload_id]);

  if (!state || state.status === 'pending' || state.status === 'processing') {
    const pct = Math.max(2, Math.min(100, state?.progress ?? 0));
    return (
      <span className="block" role="status">
        <span className="block text-[11px] text-gray-500">{t('Reading…')} {state?.step ? `· ${state.step}` : ''}</span>
        <span className="mt-1 block h-1 w-40 overflow-hidden rounded bg-gray-200"><span className="block h-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} /></span>
      </span>
    );
  }
  return state.status === 'done'
    ? <span className="block text-[11px] text-green-700">{t('Read')}</span>
    : <span className="block text-[11px] text-red-600">{t('Could not be read')}</span>;
}

export default function AttachmentMessage({ files, onSettled }: { files: AttachedFile[]; onSettled: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex justify-end">
      <ul className="max-w-[85%] space-y-1.5 rounded-2xl rounded-br-md bg-brand-50 px-3.5 py-2 text-sm text-gray-900">
        {files.map((f, i) => (
          <li key={i} className="min-w-0">
            <span className="flex items-center gap-1.5">
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-gray-500" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.5l-8.6 8.6a5 5 0 0 1-7-7l9-9a3.3 3.3 0 0 1 4.7 4.7l-9 9a1.7 1.7 0 0 1-2.4-2.4l8.3-8.3" /></svg>
              <span className="truncate">{f.name ?? t('A file')}</span>
            </span>
            {f.state === 'reading' && <Progress file={f} onSettled={onSettled} />}
            {f.state === 'already_held' && <span className="block text-[11px] text-gray-500">{t('Already in your archive')}{f.upload_id && <> · <Link to={`/uploads/${f.upload_id}`} className="text-brand-600 hover:underline">{t('Open')}</Link></>}</span>}
            {f.state === 'skipped' && <span className="block text-[11px] text-red-600">{t(SKIPPED[f.reason ?? ''] ?? msg('Not accepted.'))}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
