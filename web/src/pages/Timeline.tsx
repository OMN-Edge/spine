import { useState, useEffect, useCallback } from 'react';
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
import { useAuth } from '../auth';
import GuideTip, { GetStarted } from '../components/GuideTip';
import { useGuide } from '../guide';
import { useListTitles } from '../useListTitles';

/** How many cards the timeline draws at first, and each time the end of them is reached. */
const PAGE = 40;

/** A ref for the end of a list: `more` is called when it comes into view, so a list is read down without pressing anything. */
function useMore(more: () => void, active: boolean) {
  const [end, setEnd] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!end || !active || typeof IntersectionObserver === 'undefined') return;
    const watch = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) more(); }, { rootMargin: '600px' });
    watch.observe(end);
    return () => watch.disconnect();
  }, [end, active, more]);
  return setEnd;
}

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
  const guide = useGuide();
  // The demo says what it is above every page, and has nowhere to upload to.
  const { demo } = useAuth();
  // '' is "All years" and also the key of the undated group, so it must not count as a year that was chosen: with any undated document
  // in the list, "All years" would otherwise show only those.
  const shownYears = zoom !== '' && years.includes(zoom) ? [zoom] : years;
  // Every document is held, but only the first of them are drawn, and more as the page is read down: a card is the cost of a list, and a long
  // archive on a phone is a long page. Their titles are asked for in the interface language only as they are drawn.
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => { setLimit(PAGE); }, [filter, zoom]);
  const ordered = shownYears.flatMap(year => byYear[year]);
  const drawn = new Set(ordered.slice(0, limit).map(d => d.id));
  const { titleOf, summaryOf } = useListTitles(ordered.slice(0, limit).map(d => d.id));
  const showMore = useCallback(() => setLimit(n => n + PAGE), []);
  const endRef = useMore(showMore, ordered.length > limit);

  // On a phone five dropdowns would fill the first screen: one Filter button says how many are on and opens them, and Apply closes them (T-21).
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters = Object.values(filter).filter(Boolean).length;

  return (
    <div className="max-md:pb-20">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-[1.75rem] leading-tight font-light tracking-tight text-gray-900">{t('Timeline')}</h1>
        <button type="button" onClick={() => setFiltersOpen(o => !o)} aria-expanded={filtersOpen} aria-controls="timeline-filters" className="md:hidden rounded-full border border-gray-300 bg-white px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
          {activeFilters > 0 ? t('Filter ({count})', { count: String(activeFilters) }) : t('Filter')}
        </button>
        <div id="timeline-filters" className={`${filtersOpen ? 'flex' : 'hidden'} w-full flex-col gap-2 md:flex md:w-auto md:flex-row md:flex-wrap`}>
          <DocumentFilters value={filter} onChange={(key, v) => setFilter(f => ({ ...f, [key]: v || undefined! }))} wrapperClassName="relative w-40" />
          <Combobox
            ariaLabel={t('All types')} wrapperClassName="relative w-40" value={filter.doc_type ?? ''}
            onChange={v => setFilter(f => ({ ...f, doc_type: v || undefined! }))}
            options={[{ value: '', label: t('All types') }, ...Object.entries(DOC_TYPE_LABELS).map(([k, v]) => ({ value: k, label: t(v) }))]}
          />
          <Combobox
            ariaLabel={t('Reviewed or not')} wrapperClassName="relative w-44" value={filter.reviewed ?? ''}
            onChange={v => setFilter(f => ({ ...f, reviewed: v || undefined! }))}
            options={[{ value: '', label: t('Any review state') }, { value: 'false', label: t('Unreviewed') }, { value: 'true', label: t('Reviewed') }]}
          />
          <button type="button" onClick={() => setFiltersOpen(false)} className="md:hidden rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">{t('Apply')}</button>
        </div>
      </div>

      {!demo && samples.state?.loaded && <SampleBanner processing={samples.state.processing} onChange={samples.refresh} />}

      <GetStarted />
      {!loading && docs.length > 0 && (guide?.state?.progress.grouping_confirmed ?? 0) > 0 && (
        <GuideTip tip="tip.read" topic="checking">
          {t('Your documents are here, newest first. Open one to see what was read from it. A value marked “check” is one the AI was not sure of: compare it with the page, and correct it if it is wrong.')}
        </GuideTip>
      )}

      {waiting > 0 && (
        <div role="status" className="mb-6 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-900 flex flex-wrap items-center justify-between gap-2">
          <span>{tn(waiting, '{n} upload is waiting for you to check how its pages were grouped. Its documents appear here once you confirm.', '{n} uploads are waiting for you to check how their pages were grouped. Their documents appear here once you confirm.')}</span>
          <Link to="/upload" className="shrink-0 text-brand-600 hover:underline font-medium">{t('Check the grouping')}</Link>
        </div>
      )}

      {loading ? (
        <p className="text-gray-400 text-sm">{t('Loading…')}</p>
      ) : docs.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg mb-2">{t('No documents yet')}</p>
          {!demo && <Link to="/upload" className="text-brand-600 text-sm hover:underline">{t('Upload your first file')} →</Link>}
          {samples.state && !samples.state.loaded && <SampleOffer onChange={samples.refresh} />}
        </div>
      ) : (
        <div className="space-y-8">
          {years.length > 1 && (
            <div className="flex gap-1 overflow-x-auto sm:flex-wrap sm:overflow-visible" role="group" aria-label={t('Year')}>
              {['', ...years.filter(y => y)].map(y => (
                <button
                  key={y || 'all'} type="button" aria-pressed={zoom === y} onClick={() => setZoom(y)}
                  className={`shrink-0 text-xs px-2.5 py-1 rounded-full border ${zoom === y ? 'bg-brand-600 border-brand-600 text-white' : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'}`}
                >
                  {y || t('All years')}
                </button>
              ))}
            </div>
          )}
          {shownYears.filter(year => byYear[year].some(d => drawn.has(d.id))).map(year => (
            <div key={year}>
              <h2 className="text-xs font-medium text-gray-500 uppercase tracking-[0.12em] mb-3">{year || t('Unknown date')}</h2>
              {/* One spine per year: a reviewed document is a solid vertebra, an unreviewed one an empty amber outline. */}
              <SpineLog
                items={byYear[year].filter(d => drawn.has(d.id)).map(doc => ({
                  id: doc.id,
                  state: doc.reviewed ? 'done' : 'unreviewed',
                  children: <DocumentCard doc={{ ...doc, title: titleOf(doc), ai_summary: summaryOf(doc) }} to={`/documents/${doc.id}`} />,
                }))}
              />
            </div>
          ))}
          {ordered.length > limit && (
            <div ref={endRef} className="text-center">
              <button type="button" onClick={showMore} className="text-sm text-brand-600 hover:underline">
                {t('Show more')} ({ordered.length - limit})
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
