import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import PageImageOverlay from '../components/PageImageOverlay';
import { queueOf, type QueueItem } from '../fields-to-check';
import { fieldName, documentTitle } from '../titles';
import { useI18n } from '../i18n';
import { inputClass } from '../components/AuthCard';

/** Documents looked through for flagged values at once; the rest come when these are done. */
const LOOK_AT = 60;

/**
 * The values the model was unsure of, one at a time (T-26): the page it was read from with the place marked, the value as read, and Keep (it is right) or Save (corrected). Either makes the
 * value the owner's, so it is not flagged again. Values of results (a measurement) stay on their document's page, which this links to.
 */
export default function FieldsToCheck() {
  const { t } = useI18n();
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.documents.listAll({ reviewed: 'false' })
      .then(async docs => {
        const flagged = docs.filter(d => (d.to_check ?? 0) > 0).slice(0, LOOK_AT);
        const detailed = await Promise.all(flagged.map(d => api.documents.get(d.id).catch(() => null)));
        const items = queueOf(detailed.filter((d): d is NonNullable<typeof d> => !!d));
        setQueue(items);
        setTotal(items.length);
      })
      .catch(() => setError(t('Could not load the values to check.')));
  }, [t]);

  const current = queue?.[0];
  useEffect(() => { setValue(current?.field.value ?? ''); setError(''); }, [current?.field.id]);

  const settle = async (item: QueueItem, saved: string) => {
    setBusy(true); setError('');
    try {
      await api.documents.update(item.documentId, { fields: { update: [{ id: item.field.id, label: item.field.label, value: saved }] } });
      setQueue(q => (q ?? []).filter(i => i.field.id !== item.field.id));
    } catch { setError(t('Could not save this value.')); } finally { setBusy(false); }
  };
  const skip = () => setQueue(q => (q && q.length > 1 ? [...q.slice(1), q[0]!] : q));

  if (error && !queue) return <p className="text-sm text-red-700">{error}</p>;
  if (!queue) return <p className="text-gray-400 text-sm">{t('Loading…')}</p>;
  const done = total - queue.length;
  return (
    <div className="max-w-3xl">
      <Link to="/review" className="text-sm text-brand-600 hover:underline">{t('Back to review')}</Link>
      <h1 className="text-[1.75rem] leading-tight font-light tracking-tight text-gray-900 mt-3 mb-1">{t('Values to check')}</h1>
      {total > 0 && <p className="text-sm text-gray-500 mb-4" role="status">{t('{done} of {total} checked', { done, total })}</p>}
      {!current ? (
        <p className="text-gray-500 py-10" role="status">{total === 0 ? t('Nothing to check. No value was read with low confidence.') : t('All checked. Each value you kept or corrected is yours now and is not flagged again.')}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-500">{t('{n} left', { n: queue.length })} · <Link to={`/documents/${current.documentId}`} className="text-brand-600 hover:underline">{documentTitle({ title: current.documentTitle, doc_type: null, provider: null }, t)}</Link></p>
            <label htmlFor="check-value" className="mt-3 block text-xs font-medium text-gray-500">{fieldName(current.field.label, t)}</label>
            <textarea id="check-value" rows={3} className={`${inputClass} mt-1`} value={value} onChange={e => setValue(e.target.value)} />
            {current.field.source_snippet && <p className="text-xs text-gray-500 mb-3">{t('Read from: “{text}”', { text: current.field.source_snippet })}</p>}
            {error && <p className="text-xs text-red-700 mb-2" role="alert">{error}</p>}
            <div className="flex flex-wrap gap-2">
              {value.trim() === current.field.value.trim()
                ? <button type="button" disabled={busy} onClick={() => void settle(current, current.field.value)} className="rounded-full bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">{t('Keep')}</button>
                : <button type="button" disabled={busy || !value.trim()} onClick={() => void settle(current, value.trim())} className="rounded-full bg-brand-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">{t('Save the correction')}</button>}
              <button type="button" disabled={busy || queue.length < 2} onClick={skip} className="rounded-full border border-gray-300 px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">{t('Skip')}</button>
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-2">
            {current.page
              ? <PageImageOverlay key={current.page.id} page={current.page} number={current.page.page_number} highlightField={{ id: current.field.id, page_id: current.field.page_id, bbox_x0: current.field.bbox_x0, bbox_y0: current.field.bbox_y0, bbox_x1: current.field.bbox_x1, bbox_y1: current.field.bbox_y1 }} />
              : <p className="p-4 text-sm text-gray-500">{t('The page this was read from is not available.')}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
