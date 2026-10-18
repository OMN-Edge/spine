import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Chain, type ChainEdge, type ChainNode, type Document, type LinkKind } from '../api';
import { useI18n } from '../i18n';
import { documentTitle } from '../titles';

/** How the document being added relates to this one. `from` is the earlier of the two in the stored link. */
type Relation = 'this_requested' | 'requested_this' | 'this_follows' | 'followed_by_this' | 'same_episode';

/** The link a relation makes: which document is `from`, and its kind. */
const RELATIONS: Record<Relation, { thisIsFrom: boolean; kind: LinkKind }> = {
  this_requested: { thisIsFrom: true, kind: 'requests' },
  requested_this: { thisIsFrom: false, kind: 'requests' },
  this_follows: { thisIsFrom: false, kind: 'follow_up' },
  followed_by_this: { thisIsFrom: true, kind: 'follow_up' },
  same_episode: { thisIsFrom: true, kind: 'same_episode' },
};

/**
 * The consultations and tests around this document: what asked for it, what it asked for, what followed up. The app suggests
 * links and the owner confirms or dismisses them, or adds one by hand. Each link is shown under the later document, in words.
 */
export default function CareChain({ documentId }: { documentId: string }) {
  const { t } = useI18n();
  const [chain, setChain] = useState<Chain | null>(null);
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => api.documents.chain(documentId).then(c => { setChain(c); setFailed(false); return c; }).catch(() => { setFailed(true); return null; }), [documentId]);

  useEffect(() => {
    setChain(null); setAdding(false);
    let live = true;
    let timer: number | undefined;
    let tries = 0;
    const poll = () => load().then(c => { if (live && c?.searching && tries++ < 10) timer = window.setTimeout(poll, 3000); });
    poll();
    return () => { live = false; window.clearTimeout(timer); };
  }, [documentId, load]);

  const search = async () => {
    try { await api.documents.refreshChain(documentId); } catch { setFailed(true); return; }
    // A search runs in the background: ask again until it is over.
    let tries = 0;
    const poll = async () => { const c = await load(); if (c?.searching && tries++ < 10) window.setTimeout(poll, 3000); };
    window.setTimeout(poll, 1500);
  };

  const decide = async (e: ChainEdge, state: 'confirmed' | 'dismissed') => {
    try { await api.documents.decideLink(e.from, e.to, e.kind, state); } catch { setFailed(true); return; }
    await load();
  };

  if (!chain) return null;

  const byId = new Map(chain.nodes.map(n => [n.id, n]));
  const name = (n: ChainNode | undefined) => (n ? documentTitle(n, t) : '');
  const phrase = (e: ChainEdge): string => {
    const other = name(byId.get(e.from));
    switch (e.kind) {
      case 'requests': return t('requested by {document}', { document: other });
      case 'follow_up': return t('follow-up of {document}', { document: other });
      case 'same_episode': return t('same episode as {document}', { document: other });
    }
  };
  const hasChain = chain.nodes.length > 1;

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="font-medium text-gray-900 text-sm">{t('Care chain')}</h2>
        <div className="flex items-center gap-3 text-xs">
          {chain.enabled && (
            <button type="button" onClick={search} disabled={chain.searching} className="text-blue-600 hover:text-blue-800 disabled:text-gray-400">
              {chain.searching ? t('Looking for links…') : t('Look for links again')}
            </button>
          )}
          <button type="button" onClick={() => setAdding(a => !a)} className="text-blue-600 hover:text-blue-800">{adding ? t('Cancel') : t('Add a link')}</button>
        </div>
      </div>

      {failed && <p className="text-xs text-red-600 mb-2">{t('Something went wrong. Try again.')}</p>}

      {hasChain ? (
        <ol className="border-l-2 border-gray-200 ml-1 space-y-3">
          {chain.nodes.map(n => {
            const here = n.id === documentId;
            const incoming = chain.edges.filter(e => e.to === n.id);
            return (
              <li key={n.id} className="pl-4 relative">
                <span className={`absolute -left-[7px] top-1.5 w-3 h-3 rounded-full border-2 border-white ${here ? 'bg-blue-600' : 'bg-gray-400'}`} />
                <div className="flex items-baseline justify-between gap-3">
                  {here
                    ? <span className="text-sm font-medium text-gray-900 truncate">{name(n)}</span>
                    : <Link to={`/documents/${n.id}`} className="text-sm text-blue-700 hover:underline truncate">{name(n)}</Link>}
                  <span className="text-xs text-gray-400 shrink-0">{n.doc_date ?? ''}</span>
                </div>
                {incoming.map(e => (
                  <div key={`${e.from}|${e.kind}`} className={`mt-1 text-xs ${e.state === 'proposed' ? 'text-gray-500 italic' : 'text-gray-600'}`}>
                    <span>{phrase(e)}</span>
                    {e.state === 'proposed' && (
                      <span className="ml-2 not-italic">
                        <span className="text-gray-400">{t('suggested')}</span>{' '}
                        <button type="button" onClick={() => decide(e, 'confirmed')} className="text-green-700 hover:underline">{t('Confirm')}</button>{' · '}
                        <button type="button" onClick={() => decide(e, 'dismissed')} className="text-gray-500 hover:underline">{t('Not related')}</button>
                      </span>
                    )}
                    {e.state === 'confirmed' && (
                      <button type="button" onClick={() => decide(e, 'dismissed')} className="ml-2 not-italic text-gray-400 hover:text-gray-600 hover:underline">{t('Remove')}</button>
                    )}
                    {e.reason && e.state === 'proposed' && <div className="text-gray-400">{e.reason}</div>}
                  </div>
                ))}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-xs text-gray-400">
          {chain.searching ? t('Looking for links…') : chain.enabled ? t('No linked documents yet.') : t('No linked documents. Looking for links is switched off on this server; you can still add one.')}
        </p>
      )}

      {adding && <AddLink documentId={documentId} onDone={() => { setAdding(false); void load(); }} />}
    </div>
  );
}

function AddLink({ documentId, onDone }: { documentId: string; onDone: () => void }) {
  const { t } = useI18n();
  const [relation, setRelation] = useState<Relation>('this_requested');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Document[]>([]);
  const [picked, setPicked] = useState<Document | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setFound([]); return; }
    let live = true;
    const timer = window.setTimeout(() => {
      api.documents.list({ q, limit: '8' }).then(docs => { if (live) setFound(docs.filter(d => d.id !== documentId)); }).catch(() => { if (live) setFound([]); });
    }, 250);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query, documentId]);

  const save = async () => {
    if (!picked) return;
    const { thisIsFrom, kind } = RELATIONS[relation];
    try {
      await api.documents.addLink(thisIsFrom ? documentId : picked.id, thisIsFrom ? picked.id : documentId, kind);
      onDone();
    } catch { setError(true); }
  };

  return (
    <div className="mt-4 pt-3 border-t border-gray-100 space-y-2">
      <select value={relation} onChange={e => setRelation(e.target.value as Relation)} className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white">
        <option value="this_requested">{t('This document asked for…')}</option>
        <option value="requested_this">{t('This document was asked for by…')}</option>
        <option value="this_follows">{t('This document is a follow-up of…')}</option>
        <option value="followed_by_this">{t('This document was followed up by…')}</option>
        <option value="same_episode">{t('This document is part of the same episode as…')}</option>
      </select>
      {picked ? (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="truncate">{documentTitle(picked, t)} <span className="text-xs text-gray-400">{picked.doc_date ?? ''}</span></span>
          <button type="button" onClick={() => setPicked(null)} className="text-xs text-gray-500 hover:underline shrink-0">{t('Change')}</button>
        </div>
      ) : (
        <>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('Search for a document')} className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm" />
          {found.length > 0 && (
            <ul className="border border-gray-200 rounded-lg divide-y divide-gray-100">
              {found.map(d => (
                <li key={d.id}>
                  <button type="button" onClick={() => setPicked(d)} className="w-full text-left px-2 py-1.5 text-sm hover:bg-gray-50 flex justify-between gap-3">
                    <span className="truncate">{documentTitle(d, t)}</span>
                    <span className="text-xs text-gray-400 shrink-0">{d.doc_date ?? ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && <p className="text-xs text-red-600">{t('Something went wrong. Try again.')}</p>}
      <button type="button" onClick={save} disabled={!picked} className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white disabled:bg-gray-300">{t('Add link')}</button>
    </div>
  );
}
