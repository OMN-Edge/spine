import { useState, useEffect } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, type SharedDocument, type SharedListDocument, type TranslatedDocument, type TrendName, type TrendSeries } from '../api';
import { SeriesBody, TestList } from '../components/TrendViews';
import DocumentCard, { DOC_TYPE_LABELS } from '../components/DocumentCard';
import { DoctorsList } from '../components/DoctorsPanel';
import { MeasurementsList } from '../components/MeasurementsPanel';
import SpineLog from '../components/SpineLog';
import { LanguageSwitcher, useI18n } from '../i18n';
import { languageName, useTranslation } from '../i18n/useTranslation';
import { documentByline, documentTitle, fieldName, isSection, valueLines } from '../titles';

/**
 * What a recipient sees: the timeline and the document page of the archive, read-only. The list groups what was
 * shared by year, and opening a document (`?d=<id>`, so Back works) shows its details beside its scans when the owner
 * allowed them. No review, no reading again, no links into the owner's own pages.
 */
export default function PublicShareView() {
  const { token } = useParams<{ token: string }>();
  const [params, setParams] = useSearchParams();
  const { t, tn, lang, preferLang } = useI18n();
  const [docs, setDocs] = useState<SharedListDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [translating, setTranslating] = useState(true);
  const [original, setOriginal] = useState(false);
  const [metaReady, setMetaReady] = useState(false);
  const [type, setType] = useState('');
  const openId = params.get('d');
  const view = params.get('view') === 'trends' ? 'trends' : 'documents';
  // Values over time, when any of the shared documents has some.
  const [trendNames, setTrendNames] = useState<TrendName[]>([]);
  useEffect(() => {
    if (token) api.publicShare.trends(token).then(setTrendNames).catch(() => setTrendNames([]));
  }, [token]);

  // The page starts in the language the owner chose for this link, unless the reader has picked one here before.
  useEffect(() => {
    if (!token) return;
    api.publicShare.meta(token).then(m => { setTranslating(m.translation); preferLang(m.language); }).catch(() => {}).finally(() => setMetaReady(true));
  }, [token, preferLang]);

  // The list in the reader's language. Documents not yet translated come back as pending: ask again shortly, a few times.
  useEffect(() => {
    if (!token || !metaReady) return;
    let live = true;
    let timer: number | undefined;
    let tries = 0;
    const load = () => {
      api.publicShare.documents(token, translating ? lang : undefined)
        .then(list => {
          if (!live) return;
          setDocs(list);
          setLoading(false);
          if (translating && list.some(d => d.translation_pending) && tries++ < 20) timer = window.setTimeout(load, 2500);
        })
        .catch(err => { if (live) { setError(err.message ?? t('This link is no longer active.')); setLoading(false); } });
    };
    load();
    return () => { live = false; window.clearTimeout(timer); };
  }, [token, lang, translating, metaReady, t]);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-gray-400">{t('Loading…')}</div>;
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center max-w-sm">
          <p className="text-gray-900 font-medium mb-2">{t('Link unavailable')}</p>
          <p className="text-gray-500 text-sm">{error}</p>
        </div>
      </div>
    );
  }

  const pending = docs.some(d => d.translation_pending);
  const translated = docs.some(d => d.translation && d.translation.status !== 'same' && d.translation.status !== 'off');
  const shown = docs.filter(d => !type || d.doc_type === type);
  const types = [...new Set(docs.map(d => d.doc_type).filter((x): x is NonNullable<typeof x> => !!x))];
  const byYear = shown.reduce<Record<string, SharedListDocument[]>>((acc, doc) => {
    (acc[doc.doc_date ? doc.doc_date.slice(0, 4) : ''] ??= []).push(doc);
    return acc;
  }, {});
  const years = Object.keys(byYear).sort((a, b) => b.localeCompare(a));

  return (
    <div className="min-h-screen bg-gray-50">
      <div className={`mx-auto px-4 sm:px-6 py-8 ${openId ? 'max-w-6xl' : 'max-w-3xl'}`}>
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">{t('Medical history')}</h1>
            <p className="text-sm text-gray-400 mt-1">{t('Read-only shared view')} · {tn(docs.length, '{n} document', '{n} documents')}</p>
          </div>
          <LanguageSwitcher />
        </div>

        {trendNames.length > 0 && !openId && (
          <nav className="flex gap-4 border-b border-gray-200 mb-6 text-sm" aria-label={t('Sections')}>
            {([['documents', t('Documents'), '?'], ['trends', t('Trends'), '?view=trends']] as const).map(([key, name, to]) => (
              <Link key={key} to={to} aria-current={view === key ? 'page' : undefined}
                className={`pb-2 -mb-px border-b-2 ${view === key ? 'border-blue-600 text-blue-700 font-medium' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>
                {name}
              </Link>
            ))}
          </nav>
        )}

        {translating && (pending || translated) && !openId && view === 'documents' && (
          <p className="text-xs text-gray-500 mb-4" role="status">
            {pending ? t('Translating into your language…') : t('Translated into {language}.', { language: languageName(lang) })}{' '}
            {translated && (
              <button type="button" onClick={() => setOriginal(o => !o)} className="text-blue-600 hover:underline">
                {original ? t('Show translation') : t('Show original')}
              </button>
            )}
          </p>
        )}

        {!openId && view === 'trends' && token ? (
          <SharedTrends token={token} names={trendNames} name={params.get('name')} />
        ) : openId && token ? (
          <SharedDocumentView token={token} id={openId} translating={translating} original={original} onBack={() => setParams({}, { replace: false })} />
        ) : docs.length === 0 ? (
          <p className="text-gray-400">{t('No documents in this share.')}</p>
        ) : (
          <>
            {types.length > 1 && (
              <div className="flex justify-end mb-4">
                <select
                  aria-label={t('All types')} value={type} onChange={e => setType(e.target.value)}
                  className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">{t('All types')}</option>
                  {types.map(x => <option key={x} value={x}>{t(DOC_TYPE_LABELS[x] ?? x)}</option>)}
                </select>
              </div>
            )}
            <div className="space-y-8">
              {years.map(year => (
                <div key={year}>
                  <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">{year || t('Unknown date')}</h2>
                  <SpineLog
                    items={byYear[year].map(doc => {
                      const said = doc.translation && !original ? doc.translation : null;
                      const view = { ...doc, title: said?.title ?? doc.title, ai_summary: said?.ai_summary ?? doc.ai_summary };
                      return { id: doc.id, state: 'done' as const, children: <DocumentCard doc={view} to={`?d=${doc.id}`} owner={false} /> };
                    })}
                  />
                </div>
              ))}
            </div>
          </>
        )}

        <p className="text-xs text-gray-300 text-center mt-10">
          {t('This link was shared for a specific consultation and expires automatically.')}
        </p>
      </div>
    </div>
  );
}

const label = 'block text-xs font-medium text-gray-500 mb-1';

/** One shared document: the document page without the editing, the details beside the scans when the link allows them. */
function SharedDocumentView({ token, id, translating, original, onBack }: { token: string; id: string; translating: boolean; original: boolean; onBack: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<SharedDocument | null>(null);
  const [error, setError] = useState('');
  const [pageIdx, setPageIdx] = useState(0);
  const [showOriginal, setShowOriginal] = useState(false);
  const tr = useTranslation(translating ? id : null, (lang: string, part: 'head' | 'full'): Promise<TranslatedDocument> => api.publicShare.translation(token, id, lang, part));

  useEffect(() => {
    setData(null);
    setError('');
    setPageIdx(0);
    api.publicShare.document(token, id).then(setData).catch(err => setError(err.message ?? t('Could not open this document.')));
  }, [token, id, t]);

  const back = <button type="button" onClick={onBack} className="text-sm text-gray-500 hover:text-gray-800 mb-4">← {t('All documents')}</button>;
  if (error) return <div>{back}<p className="text-sm text-red-600">{error}</p></div>;
  if (!data) return <div>{back}<p className="text-sm text-gray-400">{t('Loading…')}</p></div>;

  const { document: doc, fields, measurements, doctors, pages, tags } = data;
  const useIt = tr.showing && !original && !showOriginal ? tr.translation : null;
  const title = useIt?.title ?? doc.title;
  const summary = useIt?.ai_summary ?? doc.ai_summary;
  const notes = useIt?.user_notes ?? doc.user_notes;
  const single = fields.filter(f => f.group_no === null);
  const groups = [...new Set(fields.filter(f => f.group_no !== null).map(f => f.group_no as number))];
  const currentPage = pages[pageIdx];

  const field = (f: SharedDocument['fields'][number]) => (
    <FieldRow key={f.id} label={useIt?.fields[f.id]?.label ?? fieldName(f.label, t)} stored={f.label} value={useIt?.fields[f.id]?.value ?? f.value} />
  );

  return (
    <div>
      {back}
      <div className="flex flex-col md:flex-row gap-6">
        <div className={`w-full shrink-0 flex flex-col gap-4 ${data.scans && pages.length > 0 ? 'md:w-96' : 'md:max-w-2xl'}`}>
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <h2 className="text-lg font-semibold text-gray-900 break-words">{documentTitle({ ...doc, title }, t)}</h2>
            <p className="text-sm text-gray-500">{documentByline(doc, t)}</p>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {tags.map(tag => <span key={tag} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{tag}</span>)}
              </div>
            )}
            {translating && (tr.translating || tr.active) && (
              <p className="text-xs text-gray-500 mt-2" role="status">
                {tr.translating ? t('Translating…') : t('Translated from {language}.', { language: languageName(tr.translation?.source_language ?? doc.language) || t('the original language') })}{' '}
                {tr.active && (
                  <button type="button" onClick={() => setShowOriginal(o => !o)} className="text-blue-600 hover:underline">
                    {showOriginal ? t('Show translation') : t('Show original')}
                  </button>
                )}
              </p>
            )}
            {summary && <p className="text-sm text-gray-700 leading-relaxed mt-4">{summary}</p>}
            {notes && (
              <div className="mt-4">
                <p className={label}>{t('Notes')}</p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{notes}</p>
              </div>
            )}
          </div>

          {doctors.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <h3 className="font-medium text-gray-900 mb-3 text-sm">{t('Doctors')}</h3>
              <DoctorsList plain doctors={doctors.map(d => ({ ...d, role: d.role as 'author', specialty: useIt && d.id in useIt.doctors ? useIt.doctors[d.id] : d.specialty }))} />
            </div>
          )}

          {measurements.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <h3 className="font-medium text-gray-900 mb-3 text-sm">{t('Measurements')}</h3>
              <MeasurementsList plain items={measurements.map(m => ({ ...m, flag: m.flag as 'low' | 'high' | 'normal' | null, name: useIt?.measurements[m.id] ?? m.name }))} />
            </div>
          )}

          {fields.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <h3 className="font-medium text-gray-900 mb-3 text-sm">{t('Details')}</h3>
              <div className="space-y-1">
                {single.map(field)}
                {groups.map(no => (
                  <div key={no} className="border border-gray-100 rounded-lg p-1 my-2">
                    {fields.filter(f => f.group_no === no).map(field)}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {data.scans && pages.length > 0 && (
          <div className="flex-1 min-w-0">
            {pages.length > 1 && (
              <div className="flex flex-wrap gap-1 mb-3">
                {pages.map((p, i) => (
                  <button
                    key={p.id} type="button" onClick={() => setPageIdx(i)}
                    className={`text-xs px-2 py-1 rounded ${i === pageIdx ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'}`}
                  >
                    {i + 1}
                  </button>
                ))}
              </div>
            )}
            {currentPage && (
              <img
                key={currentPage.id}
                src={`/api/share/${token}/pages/${currentPage.id}/image`} alt={t('Page {n}', { n: pageIdx + 1 })}
                width={currentPage.image_width} height={currentPage.image_height}
                className="w-full h-auto rounded border border-gray-200 shadow-sm bg-white"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The same rows as the document page: a short value beside its name, a long one under it. */
function FieldRow({ label: name, stored, value }: { label: string; stored: string; value: string }) {
  if (isSection(value)) {
    return (
      <div className="p-2 text-xs">
        <span className="font-medium text-gray-500">{name}</span>
        <div className="mt-1 space-y-1 text-gray-900 leading-relaxed break-words">
          {valueLines(stored, value).map((line, i) => <p key={i}>{line}</p>)}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start justify-between gap-3 p-2 text-xs">
      <span className="font-medium text-gray-500 shrink-0">{name}</span>
      <span className="text-gray-900 text-right break-words min-w-0">{value}</span>
    </div>
  );
}

/** The shared documents' values over time: the list of tests, and one test's chart. */
function SharedTrends({ token, names, name }: { token: string; names: TrendName[]; name: string | null }) {
  const { t } = useI18n();
  const [series, setSeries] = useState<TrendSeries | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setSeries(null);
    setError('');
    if (name) api.publicShare.trendSeries(token, name).then(setSeries).catch(err => setError(err.message ?? t('Could not load')));
  }, [token, name, t]);

  if (!name) return <TestList names={names} hrefFor={canonical => `?view=trends&name=${encodeURIComponent(canonical)}`} />;
  return (
    <div>
      <Link to="?view=trends" className="text-xs text-gray-400 hover:text-gray-600 block mb-3">← {t('All tests')}</Link>
      {error ? <p className="text-sm text-red-600" role="alert">{error}</p>
        : !series ? <p className="text-sm text-gray-400">{t('Loading…')}</p>
        : <SeriesBody series={series} documentHref={id => `?d=${id}`} />}
    </div>
  );
}
