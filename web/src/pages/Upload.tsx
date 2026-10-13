import { useState, useRef, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api, type UploadDocument, type UploadSummary } from '../api';
import SpineLog, { type VertebraState } from '../components/SpineLog';
import ReadWithAi from '../components/ReadWithAi';
import { documentTitle } from '../titles';
import { whereTo } from '../components/aiTarget';

interface UploadResult {
  id?: string;
  status?: string;
  skipped?: boolean;
  reason?: string;
  filename?: string | null;
  existing_id?: string;
}

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
function heading(job: JobState): string {
  if (job.documents.length > 0) return documentTitle(job.documents[0]);
  if (job.status === 'error') return 'Could not read this upload';
  if (job.status === 'duplicate') return 'Already in your archive';
  if (job.status === 'done') return 'No documents found';
  return 'Reading document…';
}

function UploadRow({ job, onRetry }: { job: JobState; onRetry: () => void }) {
  const [first, ...rest] = job.documents;
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        {first ? (
          <Link to={`/documents/${first.id}`} className="text-sm font-medium text-gray-900 truncate hover:text-blue-700">
            {heading(job)}
          </Link>
        ) : (
          <p className="text-sm font-medium text-gray-900 truncate">{heading(job)}</p>
        )}
        <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${CHIP[job.status] ?? 'bg-blue-100 text-blue-700'}`}>
          {job.status}
        </span>
      </div>
      {job.documents.length > 0 && (
        <p className="text-xs text-gray-400 mt-0.5">
          {job.uploadedAt && <>Uploaded {job.uploadedAt.slice(0, 10)} · </>}
          {job.documents.length} document{job.documents.length === 1 ? '' : 's'} ·{' '}
          <Link to={`/uploads/${job.fileId}`} className="text-blue-600 hover:underline">Pages and grouping →</Link>
        </p>
      )}
      {rest.length > 0 ? (
        <p className="text-xs text-gray-500 mt-0.5 truncate">
          and{' '}
          {rest.map((doc, i) => (
            <span key={doc.id}>
              {i > 0 && ', '}
              <Link to={`/documents/${doc.id}`} className="hover:text-blue-700">{documentTitle(doc)}</Link>
            </span>
          ))}
        </p>
      ) : job.documents.length === 0 ? (
        <p className="text-xs text-gray-400 mt-0.5">{job.step}</p>
      ) : null}
      {job.error && <p className="text-xs text-red-500 mt-1">{job.error}</p>}
      {job.status === 'error' && (
        <button type="button" onClick={onRetry} className="mt-2 text-sm text-blue-600 hover:underline">
          Try again
        </button>
      )}
      {(job.status === 'done' || job.status === 'error') && <ReadWithAi sourceFileId={job.fileId} bare />}
    </div>
  );
}

export default function Upload() {
  const [dragging, setDragging] = useState(false);
  const [jobs, setJobs] = useState<JobState[]>([]);
  // Files the server would not take, by name.
  const [refused, setRefused] = useState<Array<{ name: string; reason: string }>>([]);
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
      update(job.key, { error: err instanceof Error ? err.message : 'Could not try again' });
    }
  }, [pollStatus, update]);

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
    setRefused(results.filter(r => r.skipped && (r.reason === 'not_pdf' || r.reason === 'photo_needs_ai')).map(r => ({ name: r.filename || 'A file', reason: r.reason! })));

    results.forEach((r, i) => {
      const key = `${Date.now()}-${i}`;
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
  }, [pollStatus, update]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold text-gray-900 mb-6">Upload</h1>

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
          <span className="hidden sm:inline">Drag & drop PDFs{photos?.enabled ? ' or photos' : ''} here</span>
          <span className="sm:hidden">Tap to choose PDFs{photos?.enabled ? ' or photos' : ''}</span>
        </p>
        <p className="text-sm text-gray-400">
          <span className="hidden sm:inline">or click to browse — </span>up to 200 MB per file
        </p>
        {photos?.enabled && (
          <p className="text-xs text-gray-400 mt-3">
            A photo is sent to <strong>{photos.where}</strong> to be read: it has no text for this machine to read.
          </p>
        )}
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={photos?.enabled ? '.pdf,application/pdf,image/jpeg,image/png' : '.pdf,application/pdf'}
          className="hidden"
          onChange={e => {
            if (e.target.files?.length) handleFiles(e.target.files);
            // Cleared so picking the same file again still fires a change: the server
            // then reports it as a duplicate instead of the click doing nothing.
            e.target.value = '';
          }}
        />
      </div>

      {refused.length > 0 && (
        <div role="alert" className="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-900">
          {refused.map((r, i) => (
            <p key={i}>
              {r.reason === 'photo_needs_ai'
                ? `${r.name} was not added: a photo can only be read by sending it to the AI model, and that is switched off on this server. A scanning app that saves a PDF works without it.`
                : `${r.name} was not added: it is not a PDF${photos?.enabled ? ' or a JPEG or PNG photo' : ''}.`}
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
              label: `${heading(job)}: ${job.status}`,
              children: <UploadRow job={job} onRetry={() => retry(job)} />,
            }))}
          />
        </div>
      )}
    </div>
  );
}
