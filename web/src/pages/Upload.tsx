import { useState, useRef, useCallback } from 'react';
import { api } from '../api';

interface UploadResult {
  id?: string;
  status?: string;
  skipped?: boolean;
  reason?: string;
  existing_id?: string;
}

interface JobState {
  fileId: string;
  filename: string;
  status: string;
  progress: number;
  step: string;
  error?: string;
}

export default function Upload() {
  const [dragging, setDragging] = useState(false);
  const [jobs, setJobs] = useState<JobState[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const pollStatus = useCallback((fileId: string) => {
    const interval = setInterval(async () => {
      try {
        const s = await api.sourceFiles.status(fileId);
        setJobs(prev => prev.map(j =>
          j.fileId === fileId
            ? { ...j, status: s.status, progress: s.progress, step: s.step, error: s.error }
            : j
        ));
        if (s.status === 'done' || s.status === 'error') {
          clearInterval(interval);
        }
      } catch {
        clearInterval(interval);
      }
    }, 2000);
  }, []);

  const handleFiles = useCallback(async (fileList: FileList) => {
    const results: UploadResult[] = await api.sourceFiles.upload(fileList);
    const newJobs: JobState[] = [];

    results.forEach((r, i) => {
      const filename = fileList[i]?.name ?? 'unknown';
      if (r.skipped) {
        newJobs.push({ fileId: r.existing_id!, filename, status: 'duplicate', progress: 100, step: 'skipped (duplicate)' });
      } else if (r.id) {
        newJobs.push({ fileId: r.id, filename, status: 'processing', progress: 0, step: 'queued' });
        pollStatus(r.id);
      }
    });

    setJobs(prev => [...prev, ...newJobs]);
  }, [pollStatus]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold text-gray-900 mb-6">Upload</h1>

      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        className={`
          border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors
          ${dragging ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-gray-400 bg-white'}
        `}
      >
        <p className="text-gray-500 mb-2">Drag & drop PDFs or photos here</p>
        <p className="text-sm text-gray-400">or click to browse — up to 200 MB per file</p>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".pdf,image/*"
          className="hidden"
          onChange={e => e.target.files && handleFiles(e.target.files)}
        />
      </div>

      {jobs.length > 0 && (
        <div className="mt-6 space-y-3">
          {jobs.map(job => (
            <div key={job.fileId} className="bg-white border border-gray-200 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-gray-900 truncate">{job.filename}</p>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  job.status === 'done' ? 'bg-green-100 text-green-700'
                  : job.status === 'error' ? 'bg-red-100 text-red-700'
                  : job.status === 'duplicate' ? 'bg-gray-100 text-gray-500'
                  : 'bg-blue-100 text-blue-700'
                }`}>
                  {job.status}
                </span>
              </div>
              {job.status !== 'duplicate' && (
                <>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        job.status === 'error' ? 'bg-red-400' : 'bg-blue-500'
                      }`}
                      style={{ width: `${job.progress}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-400 mt-1">{job.step}</p>
                </>
              )}
              {job.error && <p className="text-xs text-red-500 mt-1">{job.error}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
