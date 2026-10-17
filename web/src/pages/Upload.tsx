import { useState, useRef, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api, type UploadDocument, type UploadSummary } from '../api';
import SpineLog, { type VertebraState } from '../components/SpineLog';
import { documentTitle } from '../titles';
import { whereTo } from '../components/aiTarget';
import DeleteUpload from '../components/DeleteUpload';
import { msg, useI18n } from '../i18n';
import type { I18n } from '../i18n';

interface UploadResult {
  id?: string;
  status?: string;
  skipped?: boolean;
  reason?: string;
  filename?: string | null;
  existing_id?: string;
  /** Said once for a zip: what it turned out to be and what became of its files. */
  zip?: ZipSummary;
}

interface ZipSummary {
  kind: 'spine' | 'plain';
  filename: string | null;
  restored?: number;
  accepted?: number;
  duplicates: number;
  refused?: number;
}

/** Why a file was not added, for the reasons the server gives. */
const REFUSAL_REASONS = ['not_pdf', 'photo_needs_ai', 'too_large', 'zip_unreadable', 'zip_empty', 'export_invalid', 'export_version', 'export_file_missing'];

interface JobState {
  /** Unique per row: a duplicate reuses the existing upload's id. */
  key: string;
  fileId: string;
  status: string;
  progress: number;
  step: string;
  error?: string;
  /** What the upload became. Empty until it has been read. */
  documents: UploadDocument[];
  /** When it was uploaded; absent for a row added in this visit. */
  uploadedAt?: string;
  /** Documents set aside by hiding all their pages: not listed, but the card says so. */
  hiddenDocuments?: number;
}

/** A row for an upload the server already knows about. */
function fromHistory(upload: UploadSummary): JobState {
  const finished = upload.status === 'done' || upload.status === 'error';
  return {
    key: upload.id,
    fileId: upload.id,
    status: upload.status === 'pending' ? 'processing' : upload.status,
    progress: finished ? 100 : 0,
    step: upload.status === 'done' ? 'done' : upload.status === 'error' ? 'failed' : 'processing',
    error: upload.error_message ?? undefined,
    documents: upload.documents,
    uploadedAt: upload.uploaded_at,
    hiddenDocuments: upload.hidden_documents ?? 0,
  };
}

const STATE: Record<string, VertebraState> = { done: 'done', error: 'error', duplicate: 'duplicate' };

const CHIP: Record<string, string> = {
  done: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-700',
  duplicate: 'bg-gray-100 text-gray-500',
};

/**
 * A row is named by the documents its upload produced, never by the file name. Until
 * then there is no title to show, so the row says what is happening instead.
 */
function heading(job: JobState, i18n: I18n): string {
  const { t, tn } = i18n;
  if (job.documents.length > 1) return tn(job.documents.length, '{n} document', '{n} documents');
  if (job.documents.length === 1) return documentTitle(job.documents[0], t);
  if (job.status === 'error') return t('Could not read this upload');
  if (job.status === 'duplicate') return t('Already in your archive');
  if (job.status === 'done') return job.hiddenDocuments ? t('All documents hidden') : t('No documents found');
  return t('Reading document…');
}

const STATUS_NAME: Record<string, string> = { done: msg('done'), error: msg('error'), duplicate: msg('duplicate'), processing: msg('processing'), pending: msg('pending') };

/** How many documents an upload lists on its card before "Show all". */
const LISTED_DOCUMENTS = 5;

const pagesOf = (doc: UploadDocument, t: I18n['t']) =>
  doc.page_start === doc.page_end ? t('page {n}', { n: doc.page_start }) : t('pages {from}–{to}', { from: doc.page_start, to: doc.page_end });

function UploadRow({ job, onRetry, onDeleted }: { job: JobState; onRetry: () => void; onDeleted: () => void }) {
  const i18n = useI18n();
  const { t, tn } = i18n;
  const [showAll, setShowAll] = useState(false);
  const listed = showAll ? job.documents : job.documents.slice(0, LISTED_DOCUMENTS);
  const unlisted = job.documents.length - listed.length;
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-gray-900 truncate">{heading(job, i18n)}</p>
        <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${CHIP[job.status] ?? 'bg-blue-100 text-blue-700'}`}>
          {t(STATUS_NAME[job.status] ?? job.status)}
        </span>
      </div>
      {(job.documents.length > 0 || !!job.hiddenDocuments) && (
        <p className="text-xs text-gray-400 mt-0.5">
          {job.uploadedAt && <>{t('Uploaded {date}', { date: job.uploadedAt.slice(0, 10) })} · </>}
          {job.documents.length > 0 && <>{tn(job.documents.length, '{n} document', '{n} documents')}</>}
          {job.documents.length === 1 && <> · {pagesOf(job.documents[0], t)}</>}
          {!!job.hiddenDocuments && <>{job.documents.length > 0 && ' · '}{t('{n} hidden', { n: job.hiddenDocuments })}</>}
        </p>
      )}
      {job.documents.length > 1 && (
        <ul className="mt-2 space-y-1 border-t border-gray-100 pt-2">
          {listed.map(doc => (
            <li key={doc.id} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-gray-700">
                {documentTitle(doc, t)} <span className="text-gray-400">· {pagesOf(doc, t)}</span>
              </span>
              <Link to={`/documents/${doc.id}`} className="shrink-0 text-blue-600 hover:underline">{t('View document')}</Link>
            </li>
          ))}
          {job.documents.length > LISTED_DOCUMENTS && (
            <li>
              <button type="button" onClick={() => setShowAll(v => !v)} className="text-xs text-gray-500 hover:text-gray-700 hover:underline">
                {showAll ? t('Show fewer') : t('Show all {n} documents ({more} more)', { n: job.documents.length, more: unlisted })}
              </button>
            </li>
          )}
        </ul>
      )}
      {job.documents.length === 0 && <p className="text-xs text-gray-400 mt-0.5">{job.step}</p>}
      {job.status === 'error' && <p className="text-xs text-red-500 mt-1">{t('This upload could not be read. Try again, and if it keeps failing the server log says why.')}</p>}
      {(job.documents.length > 0 || !!job.hiddenDocuments || job.status === 'done' || job.status === 'error') && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {job.status === 'error' && (
            <button type="button" onClick={onRetry} className="text-blue-600 hover:underline">{t('Try again')}</button>
          )}
          {job.documents.length === 1 && (
            <Link to={`/documents/${job.documents[0].id}`} className="text-blue-600 hover:underline">{t('View document')}</Link>
          )}
          {(job.documents.length > 0 || !!job.hiddenDocuments) && (
            <Link to={`/uploads/${job.fileId}`} className="text-blue-600 hover:underline">{t('Pages and grouping')}</Link>
          )}
          {(job.status === 'done' || job.status === 'error') && (
            <DeleteUpload fileId={job.fileId} documents={job.documents.length} onDeleted={onDeleted} />
          )}
        </div>
      )}
    </div>
  );
}

export default function Upload() {
  const i18n = useI18n();
  const { t, tx } = i18n;
  const [dragging, setDragging] = useState(false);
  const [jobs, setJobs] = useState<JobState[]>([]);
  // Files the server would not take, by name.
  const [refused, setRefused] = useState<Array<{ name: string; reason: string }>>([]);
  // What each zip turned out to be.
  const [zips, setZips] = useState<ZipSummary[]>([]);
  // Photos are read by the model, so they are offered only where the operator has allowed images to leave.
  const [photos, setPhotos] = useState<{ enabled: boolean; where: string } | null>(null);
  useEffect(() => {
    api.sourceFiles.capabilities()
      .then(c => setPhotos({ enabled: c.aiReading.enabled, where: whereTo(c.aiReading) }))
      .catch(() => setPhotos({ enabled: false, where: '' }));
  }, []);
  const fileRef = useRef<HTMLInputElement>(null);

  const update = useCallback((key: string, patch: Partial<JobState>) => {
    setJobs(prev => prev.map(j => (j.key === key ? { ...j, ...patch } : j)));
  }, []);

  const pollStatus = useCallback((key: string, fileId: string) => {
    const interval = setInterval(async () => {
      try {
        const s = await api.sourceFiles.status(fileId);
        update(key, { status: s.status, progress: s.progress, step: s.step, error: s.error, documents: s.documents ?? [] });
        if (s.status === 'done' || s.status === 'error') clearInterval(interval);
      } catch {
        clearInterval(interval);
      }
    }, 2000);
  }, [update]);

  // A failed upload run again, as it was first read; the row goes back to working and is followed like a new one.
  const retry = useCallback(async (job: JobState) => {
    try {
      await api.sourceFiles.retry(job.fileId);
      update(job.key, { status: 'processing', progress: 0, step: 'queued', error: undefined });
      pollStatus(job.key, job.fileId);
    } catch (err) {
      update(job.key, { error: err instanceof Error ? err.message : t('Could not try again') });
    }
  }, [pollStatus, update, t]);

  // The full history: every upload stays here, named by what it became, so its pages can
  // be regrouped later. Uploads still in progress pick up where they are.
  useEffect(() => {
    api.sourceFiles.list()
      .then(history => {
        setJobs(prev => {
          const known = new Set(prev.map(j => j.fileId));
          return [...prev, ...history.filter(u => !known.has(u.id)).map(fromHistory)];
        });
        for (const upload of history) {
          if (upload.status === 'pending' || upload.status === 'processing') pollStatus(upload.id, upload.id);
        }
      })
      .catch(() => {});
  }, [pollStatus]);

  const handleFiles = useCallback(async (fileList: FileList) => {
    const results: UploadResult[] = await api.sourceFiles.upload(fileList);
    const newJobs: JobState[] = [];
    setRefused(results.filter(r => r.skipped && r.reason && REFUSAL_REASONS.includes(r.reason)).map(r => ({ name: r.filename || t('A file'), reason: r.reason! })));
    setZips(results.flatMap(r => (r.zip ? [r.zip] : [])));

    results.forEach((r, i) => {
      const key = `${Date.now()}-${i}`;
      if (r.zip) return;
      if (r.skipped && r.existing_id) {
        newJobs.push({ key, fileId: r.existing_id, status: 'duplicate', progress: 100, step: 'skipped (duplicate)', documents: [] });
        // Name it by what is already in the archive.
        api.sourceFiles.status(r.existing_id)
          .then(s => update(key, { documents: s.documents ?? [] }))
          .catch(() => {});
      } else if (r.id) {
        newJobs.push({ key, fileId: r.id, status: 'processing', progress: 0, step: 'queued', documents: [] });
        pollStatus(key, r.id);
      }
    });

    setJobs(prev => [...newJobs.reverse(), ...prev]);
  }, [pollStatus, update, t]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-baseline justify-between gap-4 mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">{t('Upload')}</h1>
        <a href="/api/export" download className="text-sm text-blue-600 hover:underline" title={t('Everything you have, as a ZIP you can restore here or keep as a backup')}>{t('Export everything')}</a>
      </div>

      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        className={`
          border-2 border-dashed rounded-xl p-8 sm:p-12 text-center cursor-pointer transition-colors
          ${dragging ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-gray-400 bg-white'}
        `}
      >
        {/* A phone has nothing to drag from; it gets the file picker  */}
        <p className="text-gray-500 mb-2">
          <span className="hidden sm:inline">{photos?.enabled ? t('Drag & drop PDFs or photos here') : t('Drag & drop PDFs here')}</span>
          <span className="sm:hidden">{photos?.enabled ? t('Tap to choose PDFs or photos') : t('Tap to choose PDFs')}</span>
        </p>
        <p className="text-sm text-gray-400">
          <span className="hidden sm:inline">{t('or click to browse')} — </span>{t('up to 200 MB per file')}
        </p>
        <p className="text-xs text-gray-400 mt-1">{t('A ZIP works too: a Spine export is restored, and the PDFs in any other ZIP are added.')}</p>
        {photos?.enabled && (
          <p className="text-xs text-gray-400 mt-3">
            {tx('A photo is sent to {where} to be read: it has no text for this machine to read.', { where: <strong>{photos.where}</strong> })}
          </p>
        )}
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={photos?.enabled ? '.pdf,.zip,application/pdf,application/zip,image/jpeg,image/png' : '.pdf,.zip,application/pdf,application/zip'}
          className="hidden"
          onChange={e => {
            if (e.target.files?.length) handleFiles(e.target.files);
            // Cleared so picking the same file again still fires a change: the server
            // then reports it as a duplicate instead of the click doing nothing.
            e.target.value = '';
          }}
        />
      </div>

      {zips.length > 0 && (
        <div role="status" className="mt-4 bg-blue-50 border border-blue-200 rounded-xl p-3 text-sm text-blue-900 space-y-1">
          {zips.map((z, i) => (
            <p key={i}>
              {z.kind === 'spine'
                ? t('{name} is a Spine export: {restored} restored, {duplicates} already in your archive.', { name: z.filename ?? 'ZIP', restored: z.restored ?? 0, duplicates: z.duplicates })
                : t('{name}: {accepted} added, {duplicates} already in your archive, {refused} skipped.', { name: z.filename ?? 'ZIP', accepted: z.accepted ?? 0, duplicates: z.duplicates, refused: z.refused ?? 0 })}
            </p>
          ))}
        </div>
      )}

      {refused.length > 0 && (
        <div role="alert" className="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900">
          {refused.map((r, i) => (
            <p key={i}>
              {r.reason === 'too_large'
                ? t('{name} was not added: it is too large.', { name: r.name })
                : r.reason === 'zip_unreadable'
                ? t('{name} could not be opened as a ZIP.', { name: r.name })
                : r.reason === 'zip_empty'
                ? t('{name} has no files to add.', { name: r.name })
                : r.reason === 'export_invalid'
                ? t('{name} looks like a Spine export, but its contents are not valid.', { name: r.name })
                : r.reason === 'export_version'
                ? t('{name} was made by a newer version of Spine, which this one cannot read.', { name: r.name })
                : r.reason === 'export_file_missing'
                ? t('{name}: a file the export lists is missing from the ZIP.', { name: r.name })
                : r.reason === 'photo_needs_ai'
                ? t('{name} was not added: a photo can only be read by sending it to the AI model, and that is switched off on this server. A scanning app that saves a PDF works without it.', { name: r.name })
                : photos?.enabled
                  ? t('{name} was not added: it is not a PDF or a JPEG or PNG photo.', { name: r.name })
                  : t('{name} was not added: it is not a PDF.', { name: r.name })}
            </p>
          ))}
        </div>
      )}

      {jobs.length > 0 && (
        <div className="mt-8">
          <SpineLog
            items={jobs.map(job => ({
              id: job.key,
              state: STATE[job.status] ?? 'working',
              progress: job.progress,
              label: `${heading(job, i18n)}: ${t(STATUS_NAME[job.status] ?? job.status)}`,
              children: <UploadRow job={job} onRetry={() => retry(job)} onDeleted={() => setJobs(prev => prev.filter(j => j.fileId !== job.fileId))} />,
            }))}
          />
        </div>
      )}
    </div>
  );
}
