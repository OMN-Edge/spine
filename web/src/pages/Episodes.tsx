import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Document, type Episode } from '../api';
import { useI18n } from '../i18n';
import { Combobox } from '../components/Combobox';
import { episodeName } from '../components/episode';
import { documentTitle } from '../titles';

const box = 'bg-white border border-gray-200 rounded-xl p-4';

/** Episodes: documents that belong together. The app suggests them from the data; nothing counts until the owner confirms it. */
export default function Episodes() {
  const { t, tn } = useI18n();
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);
  const [docs, setDocs] = useState<Document[]>([]);
  const [notice, setNotice] = useState('');
  const [looking, setLooking] = useState(false);
  const [drafting, setDrafting] = useState<{ title: string; ids: string[] } | null>(null);

  const load = useCallback(async () => {
    try { setEpisodes(await api.episodes.list()); } catch { setEpisodes([]); }
  }, []);
  useEffect(() => { void load(); api.documents.listAll().then(setDocs).catch(() => setDocs([])); }, [load]);

  const byId = useMemo(() => new Map(docs.map(d => [d.id, d])), [docs]);
  const act = async (fn: () => Promise<unknown>) => {
    setNotice('');
    try { await fn(); } catch (err) { setNotice(err instanceof Error ? err.message : t('Something went wrong. Try again.')); }
    await load();
  };

  const look = async () => {
    setLooking(true);
    await act(() => api.episodes.propose());
    setLooking(false);
  };

  if (!episodes) return <p className="text-gray-400 text-sm">{t('Loading…')}</p>;
  const proposed = episodes.filter(e => e.state === 'proposed');
  const confirmed = episodes.filter(e => e.state === 'confirmed');

  const documentsOf = (ep: Episode) => (
    <ul className="mt-2 space-y-1 text-sm">
      {ep.document_ids.map(id => {
        const d = byId.get(id);
        return (
          <li key={id} className="flex items-center justify-between gap-3">
            <Link to={`/documents/${id}`} className="text-blue-700 hover:underline truncate">{d ? documentTitle(d, t) : t('Document')}</Link>
            <span className="text-xs text-gray-400 shrink-0">{d?.doc_date ?? ''}</span>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
        <h1 className="text-2xl font-semibold text-gray-900">{t('Episodes')}</h1>
        <div className="flex gap-3 text-sm">
          <button type="button" onClick={look} disabled={looking} className="text-blue-600 hover:text-blue-800 disabled:text-gray-400">{looking ? t('Looking…') : t('Look for episodes')}</button>
          <button type="button" onClick={() => setDrafting(d => (d ? null : { title: '', ids: [] }))} className="text-blue-600 hover:text-blue-800">{drafting ? t('Cancel') : t('New episode')}</button>
        </div>
      </div>
      <p className="text-sm text-gray-500 mb-6">{t('An episode groups documents that belong together, such as a visit and its tests. Spine suggests groups from the provider, the dates and the links between documents; it says nothing about the care. Nothing counts until you confirm it.')}</p>
      {notice && <p className="text-sm text-red-600 mb-3" role="alert">{notice}</p>}

      {drafting && (
        <div className={`${box} mb-6 space-y-3`}>
          <input
            value={drafting.title} maxLength={120} placeholder={t('Title (optional)')} aria-label={t('Title (optional)')}
            onChange={e => setDrafting(d => (d ? { ...d, title: e.target.value } : d))}
            className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="max-h-64 overflow-auto space-y-1">
            {docs.map(d => (
              <label key={d.id} className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={drafting.ids.includes(d.id)} onChange={e => setDrafting(x => (x ? { ...x, ids: e.target.checked ? [...x.ids, d.id] : x.ids.filter(i => i !== d.id) } : x))} />
                <span className="truncate">{documentTitle(d, t)}</span>
                <span className="text-xs text-gray-400 shrink-0">{d.doc_date ?? ''}</span>
              </label>
            ))}
          </div>
          <button
            type="button" disabled={drafting.ids.length === 0}
            onClick={() => { const d = drafting; setDrafting(null); void act(() => api.episodes.create(d.title.trim(), d.ids)); }}
            className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {t('Create the episode')}
          </button>
        </div>
      )}

      {proposed.length > 0 && (
        <section className="mb-8" aria-labelledby="suggested">
          <h2 id="suggested" className="font-medium text-gray-900 mb-3">{tn(proposed.length, '{n} suggested episode', '{n} suggested episodes')}</h2>
          <div className="space-y-3">
            {proposed.map(ep => (
              <div key={ep.id} className={`${box} border-amber-200`}>
                <p className="text-sm font-medium text-gray-900">{episodeName(ep, t)}</p>
                <p className="text-xs text-gray-500">{tn(ep.document_ids.length, '{n} document', '{n} documents')}</p>
                {documentsOf(ep)}
                <div className="mt-3 flex gap-4 text-sm">
                  <button type="button" onClick={() => act(() => api.episodes.setState(ep.id, 'confirmed'))} className="text-green-700 hover:underline">{t('Confirm')}</button>
                  <button type="button" onClick={() => act(() => api.episodes.setState(ep.id, 'dismissed'))} className="text-gray-500 hover:underline">{t('Not an episode')}</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="yours">
        <h2 id="yours" className="font-medium text-gray-900 mb-3">{t('Your episodes')}</h2>
        {confirmed.length === 0 ? (
          <p className="text-sm text-gray-400">{t('No episodes yet.')}</p>
        ) : (
          <div className="space-y-3">
            {confirmed.map(ep => (
              <EpisodeCard key={ep.id} ep={ep} docs={docs} byId={byId} onChange={fn => act(fn)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function EpisodeCard({ ep, docs, byId, onChange }: { ep: Episode; docs: Document[]; byId: Map<string, Document>; onChange: (fn: () => Promise<unknown>) => void }) {
  const { t, tn } = useI18n();
  const [title, setTitle] = useState(ep.title);
  useEffect(() => setTitle(ep.title), [ep.title]);
  const free = docs.filter(d => !ep.document_ids.includes(d.id));
  return (
    <div className={box}>
      <div className="flex items-center gap-2">
        <input
          value={title} maxLength={120} aria-label={t('Title')} placeholder={episodeName({ ...ep, title: '' }, t)}
          onChange={e => setTitle(e.target.value)}
          onBlur={() => { if (title.trim() !== ep.title) onChange(() => api.episodes.update(ep.id, { title: title.trim() })); }}
          className="flex-1 min-w-0 text-sm font-medium text-gray-900 border border-transparent hover:border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <Link to={`/?episode=${ep.id}`} className="text-xs text-blue-600 hover:underline shrink-0">{t('On the timeline')}</Link>
      </div>
      <p className="text-xs text-gray-500 px-2">{tn(ep.document_ids.length, '{n} document', '{n} documents')}</p>
      <ul className="mt-2 space-y-1 text-sm px-2">
        {ep.document_ids.map(id => {
          const d = byId.get(id);
          return (
            <li key={id} className="flex items-center justify-between gap-3">
              <Link to={`/documents/${id}`} className="text-blue-700 hover:underline truncate">{d ? documentTitle(d, t) : t('Document')}</Link>
              <span className="flex items-center gap-3 shrink-0">
                <span className="text-xs text-gray-400">{d?.doc_date ?? ''}</span>
                {ep.document_ids.length > 1 && (
                  <button type="button" aria-label={t('Take out of the episode')} title={t('Take out of the episode')} onClick={() => onChange(() => api.episodes.update(ep.id, { document_ids: ep.document_ids.filter(i => i !== id) }))} className="text-gray-400 hover:text-gray-700">×</button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 px-2">
        {free.length > 0 && (
          <Combobox
            ariaLabel={t('Add a document')} wrapperClassName="relative w-64" value=""
            onChange={v => { if (v) onChange(() => api.episodes.update(ep.id, { document_ids: [...ep.document_ids, v] })); }}
            options={[{ value: '', label: t('Add a document…') }, ...free.map(d => ({ value: d.id, label: `${documentTitle(d, t)}${d.doc_date ? ` · ${d.doc_date}` : ''}` }))]}
          />
        )}
        <button type="button" onClick={() => onChange(() => api.episodes.remove(ep.id))} className="text-xs text-gray-400 hover:text-red-600 hover:underline">{t('Remove the episode')}</button>
      </div>
    </div>
  );
}
