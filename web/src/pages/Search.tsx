import { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api, type Document } from '../api';

export default function Search() {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async () => {
    setLoading(true);
    const params: Record<string, string> = { ...filters };
    if (query.trim()) params.q = query.trim();
    api.documents.list(params)
      .then(setDocs)
      .finally(() => setLoading(false));
  }, [query, filters]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') search();
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900 mb-6">Search</h1>

      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder="Search by keyword, diagnosis, provider…"
          className="flex-1 border border-gray-300 rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          autoFocus
        />
        <button
          onClick={search}
          className="bg-blue-600 text-white rounded-xl px-5 py-2 font-medium hover:bg-blue-700"
        >
          Search
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-6">
        {[
          ['tag', 'Tag', ''],
          ['doc_type', 'Type', ''],
          ['date_from', 'From', ''],
          ['date_to', 'To', ''],
        ].map(([key, label]) => (
          <div key={key} className="flex items-center gap-1">
            <label className="text-xs text-gray-500">{label}</label>
            <input
              type={key.startsWith('date') ? 'date' : 'text'}
              value={filters[key] ?? ''}
              onChange={e => setFilters(f => ({ ...f, [key]: e.target.value || undefined! }))}
              className="text-sm border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={key === 'tag' ? 'e.g. allergy' : key === 'doc_type' ? 'e.g. lab_result' : ''}
            />
          </div>
        ))}
      </div>

      {loading && <p className="text-gray-400 text-sm">Searching…</p>}

      {docs !== null && !loading && (
        docs.length === 0 ? (
          <p className="text-gray-400 text-sm">No results</p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-gray-400 mb-3">{docs.length} result{docs.length !== 1 ? 's' : ''}</p>
            {docs.map(doc => (
              <Link
                key={doc.id}
                to={`/review/${doc.id}`}
                className="block bg-white border border-gray-200 rounded-xl p-4 hover:border-blue-300 transition-all"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{doc.provider ?? 'Unknown provider'}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{doc.doc_type} · {doc.doc_date}</p>
                    {doc.ai_summary && (
                      <p className="text-sm text-gray-500 mt-1 line-clamp-2">{doc.ai_summary}</p>
                    )}
                  </div>
                  <span className="text-xs text-gray-400 shrink-0">p. {doc.page_start}–{doc.page_end}</span>
                </div>
              </Link>
            ))}
          </div>
        )
      )}
    </div>
  );
}
