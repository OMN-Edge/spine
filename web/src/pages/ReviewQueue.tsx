import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api, type Document } from '../api';

export default function ReviewQueue() {
  const [docs, setDocs] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.documents.list({ reviewed: 'false' })
      .then(setDocs)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-gray-400 text-sm">Loading…</p>;

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900 mb-2">Review Queue</h1>
      <p className="text-sm text-gray-500 mb-6">
        {docs.length} document{docs.length !== 1 ? 's' : ''} waiting for review
      </p>

      {docs.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p>All caught up. No documents need review.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {docs.map(doc => (
            <Link
              key={doc.id}
              to={`/review/${doc.id}`}
              className="flex items-center justify-between bg-white border border-amber-200 rounded-xl p-4 hover:border-amber-300 hover:shadow-sm transition-all"
            >
              <div>
                <p className="text-sm font-medium text-gray-900">{doc.provider ?? 'Unknown provider'}</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {doc.doc_type ?? 'unknown type'} · {doc.doc_date ?? 'no date'} · pages {doc.page_start}–{doc.page_end}
                </p>
              </div>
              <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">
                Review →
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
