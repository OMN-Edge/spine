import { useEffect, useState } from 'react';
import { api } from '../api';
import { announceChange } from '../dataChanged';
import { discard, waiting, type Carried } from '../demo-carry';
import { useI18n } from '../i18n';

/**
 * Signed in, with the records open: what this browser kept from the demo (SECURITY.md M-39) is offered. Adding it restores the demo's
 * export into this account through the ordinary upload (no model call); it is deleted from the browser once every file is restored, or
 * when the person discards it. A restore that fails keeps it, and says so.
 */
export default function DemoCarryOver() {
  const { t, tn } = useI18n();
  const [carried, setCarried] = useState<Carried | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<number | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { void waiting().then(setCarried); }, []);

  const add = async () => {
    if (!carried) return;
    setBusy(true); setError('');
    try {
      const results = (await api.sourceFiles.upload([new File([carried.zip], 'spine-demo.zip', { type: 'application/zip' })])) as Array<{ zip?: { restored?: number }; id?: string; restored?: boolean }>;
      const restored = results.find(r => r.zip)?.zip?.restored;
      if (restored === undefined) throw new Error('not restored');
      // Each file is restored in the background: the browser's copy is let go only once every one of them has been, so a failure loses nothing.
      for (const id of results.flatMap(r => (r.restored && r.id ? [r.id] : []))) {
        let status = 'processing';
        for (let waited = 0; status !== 'done' && status !== 'error' && waited < 120_000; waited += 1000) {
          await new Promise(r => setTimeout(r, 1000));
          status = (await api.sourceFiles.status(id)).status;
        }
        if (status !== 'done') throw new Error('a file was not restored');
      }
      await discard();
      setCarried(null);
      setAdded(restored);
      announceChange();
    } catch {
      setError(t('Your files from the demo could not be added. Try again.'));
    }
    setBusy(false);
  };
  const drop = async () => { await discard(); setCarried(null); };

  if (added !== null) return <div role="status" className="mb-6 rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-900">{tn(added, 'The document from the demo is in your records now.', 'The {n} documents from the demo are in your records now.')}</div>;
  if (!carried) return null;
  return (
    <div role="status" className="mb-6 rounded-xl bg-brand-50 border border-brand-200 px-4 py-3 text-sm text-brand-900 flex flex-wrap items-center justify-between gap-3">
      <span>{tn(carried.files, 'This browser kept the file you read in the demo. Add it to your records?', 'This browser kept the {n} files you read in the demo. Add them to your records?')}{error && <span className="block text-red-700">{error}</span>}</span>
      <span className="flex items-center gap-3">
        <button type="button" onClick={() => void add()} disabled={busy} className="rounded-full bg-brand-600 px-3 py-1 font-medium text-white hover:bg-brand-700 disabled:opacity-50">{busy ? t('Adding…') : t('Add to my records')}</button>
        <button type="button" onClick={() => void drop()} disabled={busy} className="text-brand-700 hover:underline">{t('Discard')}</button>
      </span>
    </div>
  );
}
