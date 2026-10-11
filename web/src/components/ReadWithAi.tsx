import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

type Phase = 'idle' | 'confirm' | 'running' | 'failed';

/**
 * "Read this file with AI": for a document that came out wrong, usually handwriting or
 * a photographed page. It sends every page image of the file to the model provider, so
 * it asks first, names where the images go, and says what it replaces.
 *
 * Shown only if the operator has allowed AI reading at all.
 */
export default function ReadWithAi({ sourceFileId }: { sourceFileId: string }) {
  const navigate = useNavigate();
  const [target, setTarget] = useState<{ provider: string; endpoint: string | null } | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api.sourceFiles.capabilities()
      .then(c => setTarget(c.aiReading.enabled ? c.aiReading : null))
      .catch(() => setTarget(null));
    return () => window.clearTimeout(timer.current);
  }, []);

  if (!target) return null;

  const poll = () => {
    api.sourceFiles.status(sourceFileId).then(s => {
      // Judged on the job's step, not the stored status: the stored status can still
      // say the old result ('done' or 'error') for a moment after the click.
      if (s.step === 'complete') return navigate('/review');
      if (s.step === 'failed') {
        setError(s.error ?? 'The re-read did not finish.');
        return setPhase('failed');
      }
      setProgress(`${s.step} (${s.progress}%)`);
      timer.current = window.setTimeout(poll, 2000);
    }).catch(() => { timer.current = window.setTimeout(poll, 4000); });
  };

  const start = async () => {
    setError('');
    try {
      await api.sourceFiles.reread(sourceFileId);
      setPhase('running');
      setProgress('starting');
      timer.current = window.setTimeout(poll, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start');
      setPhase('failed');
    }
  };

  const where = target.endpoint ? `${target.provider} (${target.endpoint})` : target.provider;

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      {phase === 'idle' && (
        <>
          <p className="text-xs text-gray-500 mb-2">Handwritten, tilted or photographed, and the text came out wrong?</p>
          <button onClick={() => setPhase('confirm')} className="text-sm text-purple-700 hover:text-purple-900">
            Read this file with AI
          </button>
        </>
      )}

      {phase === 'confirm' && (
        <>
          <p className="text-sm text-gray-800 mb-2">
            This sends every page image of this file to <strong>{where}</strong> and reads it again.
          </p>
          <p className="text-xs text-gray-500 mb-3">
            It replaces the documents made from this file, including edits you made to them and any
            share links that name them. The original file is not changed.
          </p>
          <div className="flex gap-2">
            <button onClick={start} className="text-sm bg-purple-600 text-white rounded-lg px-3 py-1.5 hover:bg-purple-700">
              Send and read
            </button>
            <button onClick={() => setPhase('idle')} className="text-sm text-gray-500 hover:text-gray-700 px-2">
              Cancel
            </button>
          </div>
        </>
      )}

      {phase === 'running' && <p className="text-sm text-gray-600">Reading with AI… {progress}</p>}

      {phase === 'failed' && (
        <>
          <p className="text-sm text-red-600 mb-1">{error}</p>
          <p className="text-xs text-gray-500 mb-2">
            If it failed after reading the pages, the documents may be incomplete. The original file is
            untouched, so you can try again.
          </p>
          <button onClick={() => setPhase('confirm')} className="text-sm text-purple-700 hover:text-purple-900">
            Try again
          </button>
        </>
      )}
    </div>
  );
}
