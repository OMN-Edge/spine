import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Document } from '../api';
import { useOnDataChanged } from '../dataChanged';
import DocumentCard, { DOC_TYPE_LABELS } from '../components/DocumentCard';
import SpineLog from '../components/SpineLog';
import { useI18n } from '../i18n';
import { Combobox } from '../components/Combobox';
import { useScreen } from '../components/ChatProvider';
import DocumentFilters from '../components/DocumentFilters';
import { SampleBanner, SampleOffer, useSampleRecords } from '../components/SampleRecords';

export default function Timeline() {
  const { t, tn } = useI18n();
  const [docs, setDocs] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  // An episode can be opened from its own page (`/?episode=…`).
  const [params] = useSearchParams();
  const [filter, setFilter] = useState<Record<string, string>>(() => { const start: Record<string, string> = {}; const episode = params.get('episode'); if (episode) start.episode = episode; return start; });
  // Uploads whose pages wait for the owner to confirm the grouping: their documents are not in this list yet.
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    api.sourceFiles.list()
      .then(uploads => setWaiting(uploads.filter(u => u.status === 'done' && u.grouping_confirmed === false && (u.documents.length > 0 || !!u.hidden_documents)).length))
      .catch(() => setWaiting(0));
  }, []);

  useEffect(() => {
    setLoading(true);
    api.documents.listAll(filter)
      .then(setDocs)
      .finally(() => setLoading(false));
  }, [filter]);

  // A change made from the chat (a tag, a correction): the list is read again.
  useOnDataChanged(() => { void api.documents.listAll(filter).then(setDocs).catch(() => undefined); });

  useScreen({ page: 'timeline', documentIds: docs.slice(0, 30).map(d => d.id), filters: Object.fromEntries(Object.entries(filter).filter(([, v]) => v)) as Record<string, string> });

  // Group by year
  const byYear = docs.reduce<Record<string, Document[]>>((acc, doc) => {
    const year = doc.doc_date ? doc.doc_date.slice(0, 4) : '';
    (acc[year] ??= []).push(doc);
    return acc;
  }, {});
  const years = Object.keys(byYear).sort((a, b) => b.localeCompare(a));
  // Zoom to one year (FR-TL-01); a year that is no longer in the list (another filter was chosen) shows everything.
  const [zoom, setZoom] = useState('');
  const samples = useSampleRecords();
  // '' is "All years" and also the key of the undated group, so it must not count as a year that was chosen: with any undated document
  // in the list, "All years" would otherwise show only those.
  const shownYears = zoom !== '' && years.includes(zoom) ? [zoom] : years;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">{t('Timeline')}</h1>
        <div className="flex flex-wrap gap-2">
          <DocumentFilters value={filter} onChange={(key, v) => setFilter(f => ({ ...f, [key]: v || undefined! }))} wrapperClassName="relative w-40" />
          <Combobox
            ariaLabel={t('All types')} wrapperClassName="relative w-40" value={filter.doc_type ?? ''}
            onChange={v => setFilter(f => ({ ...f, doc_type: v || undefined! }))}
            options={[{ value: '', label: t('All types') }, ...Object.entries(DOC_TYPE_LABELS).map(([k, v]) => ({ value: k, label: t(v) }))]}
          />
          <Combobox
            ariaLabel={t('All')} wrapperClassName="relative w-36" value={filter.reviewed ?? ''}
            onChange={v => setFilter(f => ({ ...f, reviewed: v || undefined! }))}
            options={[{ value: '', label: t('All') }, { value: 'false', label: t('Unreviewed') }, { value: 'true', label: t('Reviewed') }]}
          />
        </div>
      </div>

      {samples.state?.loaded && <SampleBanner processing={samples.state.processing} onChange={samples.refresh} />}

      {waiting > 0 && (
        <div role="status" className="mb-6 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900 flex flex-wrap items-center justify-between gap-2">
          <span>{tn(waiting, '{n} upload is waiting for you to check how its pages were grouped. Its documents appear here once you confirm.', '{n} uploads are waiting for you to check how their pages were grouped. Their documents appear here once you confirm.')}</span>
          <Link to="/upload" className="shrink-0 text-blue-600 hover:underline font-medium">{t('Check the grouping')}</Link>
        </div>
      )}

      {loading ? (
        <p className="text-gray-400 text-sm">{t('Loading…')}</p>
      ) : docs.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg mb-2">{t('No documents yet')}</p>
          <Link to="/upload" className="text-blue-600 text-sm hover:underline">{t('Upload your first file')} →</Link>
          {samples.state && !samples.state.loaded && <SampleOffer onChange={samples.refresh} />}
        </div>
      ) : (
        <div className="space-y-8">
          {years.length > 1 && (
            <div className="flex flex-wrap gap-1" role="group" aria-label={t('Year')}>
              {['', ...years.filter(y => y)].map(y => (
                <button
                  key={y || 'all'} type="button" aria-pressed={zoom === y} onClick={() => setZoom(y)}
                  className={`text-xs px-2.5 py-1 rounded-full border ${zoom === y ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'}`}
                >
                  {y || t('All years')}
                </button>
              ))}
            </div>
          )}
          {shownYears.map(year => (
            <div key={year}>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">{year || t('Unknown date')}</h2>
              {/* One spine per year: a reviewed document is a solid vertebra, an unreviewed one an empty amber outline. */}
              <SpineLog
                items={byYear[year].map(doc => ({
                  id: doc.id,
                  state: doc.reviewed ? 'done' : 'unreviewed',
                  children: <DocumentCard doc={doc} to={`/documents/${doc.id}`} />,
                }))}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
