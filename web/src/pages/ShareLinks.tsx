import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api, type Document, type Episode, type ShareLink, type ShareRequest } from '../api';
import { episodeName } from '../components/episode';
import { useOnDataChanged } from '../dataChanged';
import ShareRequestCard from '../components/ShareRequestCard';
import { LANGUAGES, useI18n } from '../i18n';
import { Combobox } from '../components/Combobox';
import { languageName } from '../i18n/useTranslation';
import { DOC_TYPE_LABELS } from '../components/DocumentCard';
import { LIFETIMES } from '../lifetimes';
import { documentByline, documentTitle } from '../titles';

const input = 'w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500';
const label = 'block text-xs font-medium text-gray-500 mb-1';

/** What a link shares, in words: read from the stored scope, which is JSON for everything but `all`. */
export function describeScope(link: ShareLink, t: ReturnType<typeof useI18n>['t'], tn: ReturnType<typeof useI18n>['tn']): string {
  try {
    const value = link.scope_value ? JSON.parse(link.scope_value) : null;
    if (link.scope === 'all') return t('All history');
    if (link.scope === 'tag') return t('Tag: {name}', { name: String(value) });
    if (link.scope === 'document_ids') return tn(Array.isArray(value) ? value.length : 0, '{n} document', '{n} documents');
    if (link.scope === 'episode') return tn(Array.isArray(value) ? value.length : 0, '{n} episode', '{n} episodes');
    if (link.scope === 'date_range') return `${value?.from ?? ''} – ${value?.to ?? ''}`;
  } catch { /* an unreadable scope is shown as its kind */ }
  return link.scope;
}

/** The documents to pick from, searchable, with the ones already chosen ticked. */
export function DocumentPicker({ docs, chosen, onChange }: { docs: Document[]; chosen: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return docs.filter(d => (!type || d.doc_type === type)
      && (!q || [d.title, d.provider, d.ai_summary, d.doc_date].some(v => v?.toLowerCase().includes(q))));
  }, [docs, query, type]);
  const types = [...new Set(docs.map(d => d.doc_type).filter((x): x is NonNullable<typeof x> => !!x))];
  const picked = new Set(chosen);
  const toggle = (id: string) => onChange(picked.has(id) ? chosen.filter(x => x !== id) : [...chosen, id]);

  return (
    <div>
      <div className="flex gap-2 mb-2">
        <input
          type="search" value={query} onChange={e => setQuery(e.target.value)} aria-label={t('Search documents')}
          placeholder={t('Search documents…')} className={input}
        />
        {types.length > 1 && (
          <Combobox
            ariaLabel={t('All types')} wrapperClassName="relative w-40 shrink-0" value={type} onChange={setType}
            className="w-full text-sm border border-gray-200 rounded-lg px-2 py-2 bg-white"
            options={[{ value: '', label: t('All types') }, ...types.map(x => ({ value: x, label: t(DOC_TYPE_LABELS[x] ?? x) }))]}
          />
        )}
      </div>
      <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
        <span>{t('{n} selected', { n: chosen.length })}</span>
        <span className="flex gap-3">
          <button type="button" className="text-blue-600 hover:underline" onClick={() => onChange([...new Set([...chosen, ...shown.map(d => d.id)])])}>{t('Select all shown')}</button>
          <button type="button" className="text-blue-600 hover:underline disabled:text-gray-300 disabled:no-underline" disabled={chosen.length === 0} onClick={() => onChange([])}>{t('Clear')}</button>
        </span>
      </div>
      <ul className="max-h-72 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100 bg-white">
        {shown.length === 0 && <li className="p-3 text-sm text-gray-400">{t('No documents match.')}</li>}
        {shown.map(d => (
          <li key={d.id}>
            <label className="flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50">
              <input type="checkbox" checked={picked.has(d.id)} onChange={() => toggle(d.id)} className="mt-1" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-gray-900 truncate">{documentTitle(d, t)}</span>
                <span className="block text-xs text-gray-500 truncate">{documentByline(d, t)}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ShareLinks() {
  const { t, tn } = useI18n();
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [scope, setScope] = useState<ShareLink['scope']>('all');
  const [tag, setTag] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episodeIds, setEpisodeIds] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [form, setForm] = useState({ label: '', expires_hours: 168, include_scans: false, language: '', require_approval: false, allow_chat: false });
  const [tags, setTags] = useState<Array<{ id: number; name: string }>>([]);
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [tagged, setTagged] = useState<number | null>(null);
  const [newUrl, setNewUrl] = useState('');
  // Whether the owner is told of a request by mail; without a mailer it waits on this page.
  const [mailNote, setMailNote] = useState<boolean | null>(null);
  const [requests, setRequests] = useState<ShareRequest[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.share.list().then(setLinks).finally(() => setLoading(false));
    api.share.requests().then(setRequests).catch(() => {});
    api.tags.list().then(setTags).catch(() => {});
    api.episodes.list('confirmed').then(setEpisodes).catch(() => {});
    api.documents.listAll().then(setDocs).catch(() => setDocs([]));
  }, []);

  // A link made or revoked from the chat.
  useOnDataChanged(() => { void api.share.list().then(setLinks).catch(() => undefined); });

  // How many documents a tag holds, so the owner sees what the link would share before making it.
  useEffect(() => {
    setTagged(null);
    if (scope === 'tag' && tag) api.documents.listAll({ tag }).then(list => setTagged(list.length)).catch(() => {});
  }, [scope, tag]);

  const inRange = docs && from && to ? docs.filter(d => d.doc_date && d.doc_date >= from && d.doc_date <= to).length : null;
  const inEpisodes = new Set(episodes.filter(e => episodeIds.includes(e.id)).flatMap(e => e.document_ids)).size;
  const count = scope === 'all' ? docs?.length ?? null : scope === 'tag' ? tagged : scope === 'document_ids' ? ids.length : scope === 'episode' ? inEpisodes : inRange;
  const ready = scope === 'all' || (scope === 'tag' && !!tag) || (scope === 'document_ids' && ids.length > 0) || (scope === 'episode' && episodeIds.length > 0) || (scope === 'date_range' && !!from && !!to && from <= to);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setCreating(true);
    setError('');
    try {
      const scope_value = scope === 'tag' ? tag : scope === 'document_ids' ? ids : scope === 'episode' ? episodeIds : scope === 'date_range' ? { from, to } : undefined;
      const result = await api.share.create({
        label: form.label || undefined,
        scope,
        scope_value,
        expires_hours: form.expires_hours,
        include_scans: form.include_scans,
        language: form.language || null,
        require_approval: form.require_approval,
        allow_chat: form.allow_chat,
      });
      setNewUrl(result.url);
      setMailNote(result.approval_mail);
      setLinks(await api.share.list());
    } catch (err) {
      // The server rejects a scope it cannot fully resolve (P2), so the reason
      // has to reach the owner — otherwise the form silently does nothing.
      setNewUrl('');
      setError(err instanceof Error ? err.message : t('Could not create the link'));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    await api.share.revoke(id);
    setLinks(prev => prev.map(l => l.id === id ? { ...l, revoked: true } : l));
  };

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold text-gray-900 mb-6">{t('Share links')}</h1>

      {/* Create form */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
        <h2 className="font-medium text-gray-900 mb-4">{t('Create share link')}</h2>
        <form onSubmit={create} className="space-y-4">
          <div>
            <label htmlFor="s-label" className={label}>{t('Label (for your reference)')}</label>
            <input
              id="s-label" type="text" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
              placeholder={t('e.g. Dr. Popescu — cardiology, July 2026')} className={input}
            />
          </div>

          <div>
            <label htmlFor="s-scope" className={label}>{t('What to share')}</label>
            <Combobox
              id="s-scope" value={scope} onChange={v => setScope(v as ShareLink['scope'])} className={input}
              options={[{ value: 'all', label: t('All history') }, { value: 'tag', label: t('Documents with a tag') }, { value: 'document_ids', label: t('Documents I pick') }, ...(episodes.length > 0 ? [{ value: 'episode', label: t('Episodes') }] : []), { value: 'date_range', label: t('A date range') }]}
            />
          </div>

          {scope === 'tag' && (
            <div>
              <label htmlFor="s-tag" className={label}>{t('Tag')}</label>
              {tags.length === 0 ? (
                <p className="text-sm text-gray-400">{t('No tags yet. They are added as documents are read.')}</p>
              ) : (
                <Combobox
                  id="s-tag" value={tag} onChange={setTag} className={input} placeholder={t('Choose a tag…')}
                  options={tags.map(x => ({ value: x.name, label: x.name }))}
                />
              )}
            </div>
          )}

          {scope === 'document_ids' && (
            docs === null ? <p className="text-sm text-gray-400">{t('Loading…')}</p>
              : <DocumentPicker docs={docs} chosen={ids} onChange={setIds} />
          )}

          {scope === 'episode' && (
            <div className="space-y-1">
              {episodes.map(e => (
                <label key={e.id} className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={episodeIds.includes(e.id)} onChange={ev => setEpisodeIds(prev => (ev.target.checked ? [...prev, e.id] : prev.filter(x => x !== e.id)))} />
                  <span className="truncate">{episodeName(e, t)}</span>
                  <span className="text-xs text-gray-400 shrink-0">{tn(e.document_ids.length, '{n} document', '{n} documents')}</span>
                </label>
              ))}
              <p className="text-xs text-gray-500">{t('The link shares what the episode holds when it is opened, so a document added to the episode later is shared too.')}</p>
            </div>
          )}

          {scope === 'date_range' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="s-from" className={label}>{t('From')}</label>
                <input id="s-from" type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} className={input} />
              </div>
              <div>
                <label htmlFor="s-to" className={label}>{t('To')}</label>
                <input id="s-to" type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} className={input} />
              </div>
            </div>
          )}

          {count !== null && <p className="text-xs text-gray-500" role="status">{tn(count, 'This shares {n} document.', 'This shares {n} documents.')}</p>}

          <div>
            <label htmlFor="s-hours" className={label}>{t('Expires in')}</label>
            <select
              id="s-hours" value={form.expires_hours}
              onChange={e => setForm(f => ({ ...f, expires_hours: parseInt(e.target.value) }))}
              className="text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {LIFETIMES.map(l => <option key={l.hours} value={l.hours}>{t(l.label)}</option>)}
            </select>
          </div>

          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.include_scans} onChange={e => setForm(f => ({ ...f, include_scans: e.target.checked }))} className="mt-0.5" />
            <span>
              {t('Include scans of the original pages')}
              <span className="block text-xs text-gray-500">
                {t("The recipient also sees the page images. A scan shows everything on the page, including the patient's ID number and phone, which the extracted details leave out. Off by default.")}
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.allow_chat} onChange={e => setForm(f => ({ ...f, allow_chat: e.target.checked }))} className="mt-0.5" />
            <span>
              {t('Let the recipient ask questions')}
              <span className="block text-xs text-gray-500">
                {t("The recipient can ask an AI assistant about the documents in this link, and only those. Each question sends their words, parts of those documents (including your notes on them) and this link's label to the model provider. Nothing they ask is kept. Off by default.")}
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.require_approval} onChange={e => setForm(f => ({ ...f, require_approval: e.target.checked }))} className="mt-0.5" />
            <span>
              {t('Ask me before anyone opens it')}
              <span className="block text-xs text-gray-500">
                {t('Whoever opens the link must ask, and you approve or deny from your account. You are emailed when someone asks. Only the browser you approve can read it: the link copied elsewhere shows nothing.')}
              </span>
            </span>
          </label>

          <div>
            <label htmlFor="s-lang" className={label}>{t('Language the page opens in')}</label>
            <Combobox
              id="s-lang" value={form.language} onChange={v => setForm(f => ({ ...f, language: v }))} className={input}
              options={[{ value: '', label: t('Not set: the reader chooses') }, ...LANGUAGES.map(l => ({ value: l.code, label: l.name }))]}
            />
            <p className="text-xs text-gray-500 mt-1">{t('The reader can still switch language on the page. Extracted details and your notes are translated by the model provider.')}</p>
          </div>

          <button
            type="submit"
            disabled={creating || !ready}
            className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {creating ? t('Creating…') : t('Create link')}
          </button>
        </form>

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-xs text-red-700">{error}</p>
          </div>
        )}

        {newUrl && (
          <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg">
            <p className="text-xs text-green-700 font-medium mb-1">{t('Link created — copy and send to doctor:')}</p>
            <div className="flex items-center gap-2">
              <code className="text-sm text-green-800 break-all flex-1">{newUrl}</code>
              <button onClick={() => navigator.clipboard.writeText(newUrl)} className="text-xs text-green-600 hover:text-green-800 shrink-0">
                {t('Copy')}
              </button>
            </div>
            {mailNote === false && <p className="text-xs text-amber-700 mt-2">{t('No email is set up on this server, so requests are not emailed. They wait on this page.')}</p>}
          </div>
        )}
      </div>

      {requests.some(r => r.status === 'pending') && (
        <div className="mb-6 space-y-2" aria-live="polite">
          <h2 className="font-medium text-gray-900 mb-3">{t('Waiting for your approval')}</h2>
          {requests.filter(r => r.status === 'pending').map(r => (
            <ShareRequestCard key={r.id} request={r} onDecided={d => { setRequests(prev => prev.map(x => x.id === d.id ? d : x)); api.share.list().then(setLinks).catch(() => {}); }} />
          ))}
        </div>
      )}

      {/* Existing links */}
      {!loading && links.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-medium text-gray-900 mb-3">{t('Active links')}</h2>
          {links.map(link => {
            const expired = new Date(link.expires_at) < new Date();
            return (
              <div
                key={link.id}
                className={`bg-white border rounded-xl p-4 ${link.revoked || expired ? 'opacity-50 border-gray-200' : 'border-gray-200'}`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{link.label ?? describeScope(link, t, tn)}</p>
                    {link.label && <p className="text-xs text-gray-500 mt-0.5">{describeScope(link, t, tn)}</p>}
                    <p className="text-xs text-gray-500 mt-0.5">
                      {link.revoked ? t('Revoked') : expired ? t('Expired') : t('Expires {date}', { date: link.expires_at.slice(0, 10) })}
                      {' · '}{tn(link.view_count, '{n} view', '{n} views')}
                      {' · '}{link.include_scans ? t('scans included') : t('details only')}
                      {link.language && <>{' · '}{languageName(link.language)}</>}
                      {link.require_approval && <>{' · '}{t('needs your approval')}</>}
                      {link.allow_chat && <>{' · '}{t('questions allowed')}</>}
                      {link.pending_requests > 0 && <>{' · '}{t('{n} waiting', { n: link.pending_requests })}</>}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <Link to={`/share-links/${link.id}`} className="text-xs text-blue-600 hover:underline">{t('Manage')}</Link>
                    {!link.revoked && !expired && (
                      <button onClick={() => revoke(link.id)} className="text-xs text-red-500 hover:text-red-700">
                        {t('Revoke')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
