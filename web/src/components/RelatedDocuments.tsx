import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type RelatedDocument, type RelatedReason } from '../api';
import { useI18n } from '../i18n';
import { documentTitle } from '../titles';

/**
 * Other documents in the archive that belong with this one, and why: the same test (so its values can be read together),
 * the same doctor, and, when this server can compare meaning, ones that read alike. The reasons from the data come first
 * because they are exact.
 */
export default function RelatedDocuments({ documentId }: { documentId: string }) {
  const { t, lang } = useI18n();
  const [data, setData] = useState<{ related: RelatedDocument[]; meaning: { enabled: boolean; ready: boolean } } | null>(null);

  useEffect(() => {
    setData(null);
    let live = true;
    let timer: number | undefined;
    let tries = 0;
    const load = () => api.documents.related(documentId, lang)
      .then(next => {
        if (!live) return;
        setData(next);
        // Vectors and translated titles are made in the background: ask again shortly, a few times.
        if (((next.meaning.enabled && !next.meaning.ready) || next.translation_pending) && tries++ < 6) timer = window.setTimeout(load, 4000);
      })
      .catch(() => { if (live) setData({ related: [], meaning: { enabled: false, ready: true } }); });
    load();
    return () => { live = false; window.clearTimeout(timer); };
  }, [documentId, lang]);

  if (!data || (data.related.length === 0 && (!data.meaning.enabled || data.meaning.ready))) return null;

  const why = (r: RelatedReason): string => {
    switch (r.kind) {
      case 'tests': return t('same test: {names}', { names: r.names.join(', ') });
      case 'doctors': return t('same doctor: {names}', { names: r.names.join(', ') });
      case 'tags': return t('same tags: {names}', { names: r.names.join(', ') });
      case 'provider': return t('same provider');
      case 'meaning': return t('reads alike');
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <h2 className="font-medium text-gray-900 mb-3 text-sm">{t('Similar documents')}</h2>
      {data.related.length === 0 ? (
        <p className="text-xs text-gray-400">{t('Looking for documents that read alike…')}</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {data.related.map(r => (
            <li key={r.id}>
              <Link to={`/documents/${r.id}`} className="block py-2 hover:bg-gray-50 rounded-lg px-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-gray-900 truncate">{documentTitle({ ...r, title: r.translated_title || r.title }, t)}</span>
                  <span className="text-xs text-gray-400 shrink-0">{r.doc_date ?? ''}</span>
                </span>
                <span className="block text-xs text-gray-500 mt-0.5">
                  {r.reasons.filter(x => x.kind !== 'tags' && x.kind !== 'provider').map(why).join(' · ')}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
