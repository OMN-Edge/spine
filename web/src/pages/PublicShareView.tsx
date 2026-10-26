import DeviceImg from '../components/DeviceImg';
import { useState, useEffect } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { api, type SharedDocument, type SharedListDocument, type TranslatedDocument, type TrendName, type TrendSeries } from '../api';
import { SeriesBody, TestList } from '../components/TrendViews';
import DocumentCard, { DOC_TYPE_LABELS } from '../components/DocumentCard';
import { DoctorsList } from '../components/DoctorsPanel';
import { MeasurementsList } from '../components/MeasurementsPanel';
import SpineLog from '../components/SpineLog';
import SharedChat from '../components/SharedChat';
import SharedConnections from '../components/SharedConnections';
import { LanguageSwitcher, useI18n } from '../i18n';
import { useShareAccess } from '../core/share/access';
import { Combobox } from '../components/Combobox';
import { languageName, useTranslation } from '../i18n/useTranslation';
import AiLabel from '../components/AiLabel';
import { documentByline, documentTitle, fieldName, isCriticalField, isSection, valueLines } from '../titles';

/**
 * A link the owner wants to approve is not opened until this browser is let in (SECURITY.md M-19). The page asks the
 * server where the browser stands, offers to ask the owner, waits while they decide, and only then loads the documents.
 * Nothing is requested from the documents' routes before that: they would answer 403.
 */
export default function PublicShareView() {
  const { id: shareId } = useParams<{ id: string }>();
  const { t } = useI18n();
  const { state, ask, error } = useShareAccess(shareId);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  if (!shareId) return null;
  if (state === 'open') return <SharedContent shareId={shareId} />;
  if (state === 'checking') return <div className="min-h-screen flex items-center justify-center text-gray-400">{t('Loading…')}</div>;
  if (state === 'gone' || state === 'broken') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center max-w-sm">
          <p className="text-gray-900 font-medium mb-2">{t('Link unavailable')}</p>
          <p className="text-gray-500 text-sm">{state === 'gone' ? t('This link is no longer active.') : t('This address is incomplete or damaged. Ask the person who shared it for the whole link.')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-sm w-full text-center">
        <p className="text-gray-900 font-medium mb-2">{t('Approval needed')}</p>
        {state === 'needed' && (
          <>
            <p className="text-gray-500 text-sm mb-4">{t('The person who shared this asks to approve who opens it. Send them a request; it works in this browser only.')}</p>
            <label htmlFor="req-note" className="block text-xs text-gray-500 text-left mb-1">{t('Who are you? (optional)')}</label>
            <input id="req-note" value={note} maxLength={120} onChange={e => setNote(e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 mb-3" />
            <button disabled={busy} onClick={async () => { setBusy(true); try { await ask(note); } finally { setBusy(false); } }} className="w-full bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50">{t('Ask for access')}</button>
            {error && <p className="text-xs text-red-600 mt-3" role="alert">{t('Could not send the request')}</p>}
          </>
        )}
        {state === 'pending' && <p className="text-gray-500 text-sm" role="status">{t('Your request was sent. Keep this page open: it opens when the owner approves.')}</p>}
        {state === 'denied' && <p className="text-gray-500 text-sm" role="alert">{t('The owner did not approve this request.')}</p>}
        <div className="mt-6 flex justify-center"><LanguageSwitcher /></div>
      </div>
    </div>
  );
}

/**
 * What a recipient sees: the timeline and the document page of the archive, read-only. The list groups what was
 * shared by year, and opening a document (`?d=<id>`, so Back works) shows its details beside its scans when the owner
 * allowed them. No review, no reading again, no links into the owner's own pages.
 */
function SharedContent({ shareId }: { shareId: string }) {
  const [params, setParams] = useSearchParams();
  const { t, tn, lang, preferLang } = useI18n();
  const [docs, setDocs] = useState<SharedListDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [translating, setTranslating] = useState(true);
  const [original, setOriginal] = useState(false);
  const [metaReady, setMetaReady] = useState(false);
  const [landingUrl, setLandingUrl] = useState<string | null>(null);
  const [chatOn, setChatOn] = useState(false);
  const [type, setType] = useState('');
  const openId = params.get('d');
  const view = params.get('view') === 'trends' ? 'trends' : 'documents';
  // Values over time, when any of the shared documents has some.
  const [trendNames, setTrendNames] = useState<TrendName[]>([]);
  useEffect(() => {
    if (shareId) api.publicShare.trends(shareId).then(setTrendNames).catch(() => setTrendNames([]));
  }, [shareId]);

  // The page starts in the language the owner chose for this link, unless the reader has picked one here before.
  useEffect(() => {
    if (!shareId) return;
    api.publicShare.meta(shareId).then(m => { setTranslating(m.translation); setChatOn(m.chat); setLandingUrl(m.landing_url); preferLang(m.language); }).catch(() => {}).finally(() => setMetaReady(true));
  }, [shareId, preferLang]);

  // The list in the reader's language. Documents not yet translated come back as pending: ask again shortly, a few times.
  useEffect(() => {
    if (!shareId || !metaReady) return;
    let live = true;
    let timer: number | undefined;
    let tries = 0;
    const load = () => {
      api.publicShare.documents(shareId, translating ? lang : undefined)
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
  }, [shareId, lang, translating, metaReady, t]);

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

        {chatOn && <SharedChat shareId={shareId} openId={openId} titleOf={source => (original ? null : docs.find(d => d.id === source.id)?.translation?.title)} />}

        {!openId && view === 'trends' && shareId ? (
          <SharedTrends shareId={shareId} names={trendNames} name={params.get('name')} />
        ) : openId && shareId ? (
          <SharedDocumentView shareId={shareId} id={openId} translating={translating} original={original} titleOf={docId => (original ? null : docs.find(d => d.id === docId)?.translation?.title)} onBack={() => setParams({}, { replace: false })} />
        ) : docs.length === 0 ? (
          <p className="text-gray-400">{t('No documents in this share.')}</p>
        ) : (
          <>
            {types.length > 1 && (
              <div className="flex justify-end mb-4">
                <Combobox
                  ariaLabel={t('All types')} wrapperClassName="relative w-44" value={type} onChange={setType}
                  options={[{ value: '', label: t('All types') }, ...types.map(x => ({ value: x, label: t(DOC_TYPE_LABELS[x] ?? x) }))]}
                />
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
        <p className="text-xs text-gray-400 text-center mt-2">
          {landingUrl
            ? <a href={landingUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{t('Shared securely via Spine')}</a>
            : t('Shared securely via Spine')}
        </p>
      </div>
    </div>
  );
}

const label = 'block text-xs font-medium text-gray-500 mb-1';

/** One shared document: the document page without the editing, the details beside the scans when the link allows them. */
function SharedDocumentView({ shareId, id, translating, original, titleOf, onBack }: { shareId: string; id: string; translating: boolean; original: boolean; titleOf: (id: string) => string | null | undefined; onBack: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<SharedDocument | null>(null);
  const [error, setError] = useState('');
  const [pageIdx, setPageIdx] = useState(0);
  const [showOriginal, setShowOriginal] = useState(false);
  const tr = useTranslation(translating ? id : null, (lang: string, part: 'head' | 'full'): Promise<TranslatedDocument> => api.publicShare.translation(shareId, id, lang, part));

  useEffect(() => {
    setData(null);
    setError('');
    setPageIdx(0);
    api.publicShare.document(shareId, id).then(setData).catch(err => setError(err.message ?? t('Could not open this document.')));
  }, [shareId, id, t]);

  // A link from the assistant's answer can point at a part of the page: ?section=results scrolls there and lights it briefly.
  // Again for the same part when the link is followed again, which is why the location's key is a dependency.
  const location = useLocation();
  useEffect(() => {
    const section = new URLSearchParams(location.search).get('section');
    if (!section || !data) return;
    const el = document.getElementById(`section-${section}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('ring-2', 'ring-blue-400');
    const timer = window.setTimeout(() => el.classList.remove('ring-2', 'ring-blue-400'), 2200);
    return () => { window.clearTimeout(timer); el.classList.remove('ring-2', 'ring-blue-400'); };
  }, [location.key, location.search, data]);

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
    <FieldRow
      key={f.id} label={useIt?.fields[f.id]?.label ?? fieldName(f.label, t)} stored={f.label} value={useIt?.fields[f.id]?.value ?? f.value}
      original={useIt && useIt.fields[f.id] && useIt.fields[f.id].value !== f.value ? f.value : null}
      critical={!!useIt && isCriticalField(f.label)}
    />
  );

  return (
    <div>
      {back}
      <div className="flex flex-col md:flex-row gap-6">
        <div className={`w-full shrink-0 flex flex-col gap-4 ${data.scans && pages.length > 0 ? 'md:w-96' : 'md:max-w-2xl'}`}>
          <div id="section-summary" className="bg-white border border-gray-200 rounded-xl p-4 transition-shadow">
            <h2 className="text-lg font-semibold text-gray-900 break-words">{documentTitle({ ...doc, title }, t)}</h2>
            <p className="text-sm text-gray-500">{documentByline(doc, t)}</p>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {tags.map(tag => <span key={tag} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{tag}</span>)}
              </div>
            )}
            {translating && (tr.translating || tr.active) && (
              <p className="text-xs text-gray-500 mt-2" role="status">
                {tr.translating ? t('Translating…') : t('Machine translation from {language}. The original document prevails: check it before relying on a detail.', { language: languageName(tr.translation?.source_language ?? doc.language) || t('the original language') })}{' '}
                {tr.active && (
                  <button type="button" onClick={() => setShowOriginal(o => !o)} className="text-blue-600 hover:underline">
                    {showOriginal ? t('Show translation') : t('Show original')}
                  </button>
                )}
              </p>
            )}
            {summary && <p className="text-sm text-gray-700 leading-relaxed mt-4"><AiLabel className="mr-1.5" />{summary}</p>}
            {useIt && doc.ai_summary && summary !== doc.ai_summary && <Original text={doc.ai_summary} />}
            {notes && (
              <div id="section-notes" className="mt-4 rounded-lg transition-shadow">
                <p className={label}>{t('Notes')}</p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{notes}</p>
                {useIt && doc.user_notes && notes !== doc.user_notes && <Original text={doc.user_notes} />}
              </div>
            )}
          </div>

          {doctors.length > 0 && (
            <div id="section-doctors" className="bg-white border border-gray-200 rounded-xl p-4 transition-shadow">
              <h3 className="font-medium text-gray-900 mb-3 text-sm">{t('Doctors')}</h3>
              <DoctorsList plain doctors={doctors.map(d => ({ ...d, role: d.role as 'author', specialty: useIt && d.id in useIt.doctors ? useIt.doctors[d.id] : d.specialty }))} />
            </div>
          )}

          {measurements.length > 0 && (
            <div id="section-results" className="bg-white border border-gray-200 rounded-xl p-4 transition-shadow">
              <h3 className="font-medium text-gray-900 mb-3 text-sm">{t('Measurements')}</h3>
              <MeasurementsList plain items={measurements.map(m => ({ ...m, flag: m.flag as 'low' | 'high' | 'normal' | null, name: useIt?.measurements[m.id] ?? m.name }))} />
            </div>
          )}

          {fields.length > 0 && (
            <div id="section-fields" className="bg-white border border-gray-200 rounded-xl p-4 transition-shadow">
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

          <SharedConnections shareId={shareId} id={id} titleOf={titleOf} />
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
              <DeviceImg
                key={currentPage.id}
                src={`/api/share/${shareId}/pages/${currentPage.id}/image`} alt={t('Page {n}', { n: pageIdx + 1 })}
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
function FieldRow({ label: name, stored, value, original = null, critical = false }: { label: string; stored: string; value: string; original?: string | null; critical?: boolean }) {
  const { t } = useI18n();
  // In a translation: the original under the translated value, and allergies, medicines and doses marked to be checked against it.
  const mark = critical ? 'bg-amber-50 border border-amber-300 rounded-lg' : '';
  const was = original && (
    <p className="mt-1 text-gray-500 break-words">{critical && <span className="font-medium text-amber-800">{t('Check against the original')}: </span>}{t('Original')}: {original}</p>
  );
  if (isSection(value)) {
    return (
      <div className={`p-2 text-xs ${mark}`}>
        <span className="font-medium text-gray-500">{name}</span>
        <div className="mt-1 space-y-1 text-gray-900 leading-relaxed break-words">
          {valueLines(stored, value).map((line, i) => <p key={i}>{line}</p>)}
        </div>
        {was}
      </div>
    );
  }
  return (
    <div className={`p-2 text-xs ${mark}`}>
      <div className="flex items-start justify-between gap-3">
        <span className="font-medium text-gray-500 shrink-0">{name}</span>
        <span className="text-gray-900 text-right break-words min-w-0">{value}</span>
      </div>
      {was}
    </div>
  );
}

/** The document's own words under their translation. */
function Original({ text }: { text: string }) {
  const { t } = useI18n();
  return (
    <details className="mt-2 text-xs text-gray-500">
      <summary className="cursor-pointer">{t('Original text')}</summary>
      <p className="mt-1 whitespace-pre-wrap">{text}</p>
    </details>
  );
}

/** The shared documents' values over time: the list of tests, and one test's chart. */
function SharedTrends({ shareId, names, name }: { shareId: string; names: TrendName[]; name: string | null }) {
  const { t } = useI18n();
  const [series, setSeries] = useState<TrendSeries | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setSeries(null);
    setError('');
    if (name) api.publicShare.trendSeries(shareId, name).then(setSeries).catch(err => setError(err.message ?? t('Could not load')));
  }, [shareId, name, t]);

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
