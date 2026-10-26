import { useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';

/**
 * Deleting an upload removes everything made from it and cannot be undone, so the button only
 * opens a panel, and the panel's button stays off until the word "delete" is typed.
 */
export default function DeleteUpload({
  fileId, documents, onDeleted, label, className = '',
}: {
  fileId: string;
  documents: number;
  onDeleted: () => void;
  /** The trigger's text. */
  label?: string;
  className?: string;
}) {
  const { t, tn } = useI18n();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const close = () => { setOpen(false); setTyped(''); setError(''); };

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await api.sourceFiles.remove(fileId);
      onDeleted();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : t('Could not delete this upload'));
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={`text-red-600 hover:underline ${className}`}>
        {label ?? t('Delete')}
      </button>
    );
  }

  return (
    <div role="alertdialog" aria-label={t('Delete this upload?')} className="basis-full mt-2 bg-red-50 border border-red-200 rounded-lg p-3 text-xs">
      <p className="text-red-900">
        {tn(documents, 'This deletes the upload, its {n} document, their details and measurements, the page images and the original file. The copy of your sealed records in the backup is replaced at the next daily backup. It cannot be undone.', 'This deletes the upload, its {n} documents, their details and measurements, the page images and the original file. The copy of your sealed records in the backup is replaced at the next daily backup. It cannot be undone.')}
      </p>
      <label className="block mt-2 text-red-900">
        {t('Type delete to confirm')}
        <input
          value={typed} onChange={e => setTyped(e.target.value)} autoFocus disabled={busy}
          className="mt-1 block w-40 rounded-md border border-red-200 bg-white px-2 py-1 text-xs text-gray-900"
        />
      </label>
      {error && <p className="mt-2 text-red-700">{error}</p>}
      <div className="flex gap-2 mt-3">
        <button
          type="button" onClick={remove} disabled={busy || typed.trim().toLowerCase() !== 'delete'}
          className="bg-red-600 text-white rounded-lg px-3 py-1.5 text-xs hover:bg-red-700 disabled:opacity-40"
        >
          {busy ? t('Deleting…') : t('Delete everything')}
        </button>
        <button type="button" onClick={close} disabled={busy} className="px-3 py-1.5 rounded-lg text-xs text-gray-600 border border-gray-300 hover:bg-white">
          {t('Cancel')}
        </button>
      </div>
    </div>
  );
}
