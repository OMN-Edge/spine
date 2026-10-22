import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { announceChange } from '../dataChanged';
import { useI18n } from '../i18n';

/**
 * Sample records (FR-ACC-03): invented documents to explore before uploading anything real. `Offer` is the button on an empty
 * archive; `Banner` tells, while they are in the archive, that they are samples and takes them away in one step.
 */
export function useSampleRecords() {
  const [state, setState] = useState<{ loaded: boolean; processing: boolean } | null>(null);
  const refresh = useCallback(async () => { try { setState(await api.demo.state()); } catch { setState({ loaded: false, processing: false }); } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  // While they are being set up, ask again, and tell the page when they are there.
  useEffect(() => {
    if (!state?.processing) return;
    const timer = window.setTimeout(async () => { await refresh(); announceChange(); }, 1500);
    return () => window.clearTimeout(timer);
  }, [state, refresh]);
  return { state, refresh };
}

export function SampleOffer({ onChange }: { onChange: () => void }) {
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    setBusy(true); setError('');
    try { await api.demo.load(lang === 'ro' ? 'ro' : 'en'); onChange(); } catch (err) { setError(err instanceof Error ? err.message : t('Something went wrong. Try again.')); }
    setBusy(false);
  };
  return (
    <div className="mt-6">
      <button type="button" onClick={load} disabled={busy} className="rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:border-blue-300 disabled:opacity-50">
        {busy ? t('Setting up…') : t('Explore with sample records')}
      </button>
      <p className="mt-2 text-xs text-gray-500">{t('A few invented documents about nobody, so you can look around first. You can remove them in one step.')}</p>
      {error && <p className="mt-2 text-xs text-red-600" role="alert">{error}</p>}
    </div>
  );
}

export function SampleBanner({ processing, onChange }: { processing: boolean; onChange: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const remove = async () => {
    setBusy(true); setError('');
    try { await api.demo.remove(); announceChange(); onChange(); } catch (err) { setError(err instanceof Error ? err.message : t('Something went wrong. Try again.')); }
    setBusy(false);
  };
  return (
    <div role="status" className="mb-6 rounded-xl bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-900 flex flex-wrap items-center justify-between gap-3">
      <span>{processing ? t('Setting up the sample records…') : t('These are sample records, invented for trying Spine. Nothing here is about a person.')}</span>
      <span className="flex items-center gap-3">
        {error && <span className="text-red-700">{error}</span>}
        <button type="button" onClick={remove} disabled={busy || processing} className="shrink-0 text-blue-700 hover:underline font-medium disabled:opacity-50">{t('Remove the sample records')}</button>
      </span>
    </div>
  );
}
