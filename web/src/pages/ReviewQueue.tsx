import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api, type Document } from '../api';
import { documentByline, documentTitle } from '../titles';
import SpineLog from '../components/SpineLog';
import { useI18n } from '../i18n';
import { useScreen } from '../components/ChatProvider';

export default function ReviewQueue() {
  const { t, tn } = useI18n();
  const [docs, setDocs] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);

  useScreen({ page: 'review', documentIds: docs.slice(0, 30).map(d => d.id) });

  useEffect(() => {
    api.documents.listAll({ reviewed: 'false' })
      .then(setDocs)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-gray-400 text-sm">{t('Loading…')}</p>;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900 mb-2">{t('Review queue')}</h1>
      <p className="text-sm text-gray-500 mb-6">
        {tn(docs.length, '{n} document waiting for review', '{n} documents waiting for review')}
      </p>

      {docs.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p>{t('All caught up. No documents need review.')}</p>
        </div>
      ) : (
        // Loose vertebrae: these have not joined the spine yet. Reviewing one adds it to the timeline's.
        <SpineLog
          loose
          items={docs.map(doc => ({
            id: doc.id,
            state: 'unreviewed',
            children: (
              <Link
                to={`/documents/${doc.id}?edit=1`}
                className="flex items-center justify-between gap-3 bg-white border border-amber-200 rounded-xl p-4 hover:border-amber-300 hover:shadow-sm transition-all"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{documentTitle(doc, t)}</p>
                  <p className="text-xs text-gray-500 mt-0.5 truncate">
                    {[documentByline(doc, t), t('pages {from}–{to}', { from: doc.page_start, to: doc.page_end })].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <span className="shrink-0 text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">
                  {t('Review')} →
                </span>
              </Link>
            ),
          }))}
        />
      )}
    </div>
  );
}
