import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type SharedConnections as Connections } from '../api';
import { useI18n } from '../i18n';
import { documentTitle } from '../titles';

/**
 * Around a shared document, for the recipient: what the owner linked to it (a consultation and the tests it asked for, a
 * follow-up) and which shared documents read alike. Only documents the link shares appear, each opens in this page, and the
 * names follow the page's language where the list has translated them.
 */
export default function SharedConnections({ shareId, id, titleOf }: { shareId: string; id: string; titleOf: (id: string) => string | null | undefined }) {
  const { t } = useI18n();
  const [data, setData] = useState<Connections | null>(null);

  useEffect(() => {
    setData(null);
    let live = true;
    api.publicShare.connections(shareId, id).then(d => { if (live) setData(d); }).catch(() => { if (live) setData({ chain: null, related: [] }); });
    return () => { live = false; };
  }, [shareId, id]);

  if (!data || (!data.chain && data.related.length === 0)) return null;

  const name = (n: { id: string; title: string | null; doc_type: Connections['related'][number]['doc_type']; provider: string | null }) =>
    documentTitle({ ...n, title: titleOf(n.id) || n.title }, t);

  const chain = data.chain;
  const byId = new Map((chain?.nodes ?? []).map(n => [n.id, n]));
  const phrase = (e: NonNullable<Connections['chain']>['edges'][number]): string => {
    const other = byId.get(e.from);
    const document = other ? name(other) : '';
    switch (e.kind) {
      case 'requests': return t('requested by {document}', { document });
      case 'follow_up': return t('follow-up of {document}', { document });
      case 'same_episode': return t('same episode as {document}', { document });
    }
  };

  return (
    <>
      {chain && (
        <div id="section-chain" className="bg-white border border-gray-200 rounded-xl p-4 transition-shadow">
          <h3 className="font-medium text-gray-900 mb-3 text-sm">{t('Connected documents')}</h3>
          <ol className="border-l-2 border-gray-200 ml-1 space-y-3">
            {chain.nodes.map(n => {
              const here = n.id === id;
              return (
                <li key={n.id} className="pl-4 relative">
                  <span className={`absolute -left-[7px] top-1.5 w-3 h-3 rounded-full border-2 border-white ${here ? 'bg-brand-600' : 'bg-gray-400'}`} />
                  <div className="flex items-baseline justify-between gap-3">
                    {here
                      ? <span className="text-sm font-medium text-gray-900 truncate">{name(n)}</span>
                      : <Link to={`?d=${n.id}`} className="text-sm text-brand-700 hover:underline truncate">{name(n)}</Link>}
                    <span className="text-xs text-gray-400 shrink-0">{n.doc_date ?? ''}</span>
                  </div>
                  {chain.edges.filter(e => e.to === n.id).map(e => (
                    <div key={`${e.from}|${e.kind}`} className="mt-1 text-xs text-gray-600">{phrase(e)}</div>
                  ))}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {data.related.length > 0 && (
        <div id="section-related" className="bg-white border border-gray-200 rounded-xl p-4 transition-shadow">
          <h3 className="font-medium text-gray-900 mb-3 text-sm">{t('Similar documents')}</h3>
          <ul className="divide-y divide-gray-100">
            {data.related.map(r => (
              <li key={r.id}>
                <Link to={`?d=${r.id}`} className="block py-2 hover:bg-gray-50 rounded-lg px-1">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-gray-900 truncate">{name(r)}</span>
                    <span className="text-xs text-gray-400 shrink-0">{r.doc_date ?? ''}</span>
                  </span>
                  <span className="block text-xs text-gray-500 mt-0.5">
                    {r.reasons.map(x => x.kind === 'tests' ? t('same test: {names}', { names: x.names.join(', ') })
                      : x.kind === 'doctors' ? t('same doctor: {names}', { names: x.names.join(', ') })
                      : t('reads alike')).join(' · ')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
