import { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api, type Document } from '../api';
import { documentByline, documentTitle } from '../titles';
import SpineLog from '../components/SpineLog';

/** The server marks each match with \u0001 … \u0002; they become emphasis here, and everything else stays plain text. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/[\u0001\u0002]/);
  return (
    <p className="text-xs text-gray-600 mt-1 line-clamp-2" data-testid="snippet">
      {parts.map((part, i) => (i % 2 === 1 ? <mark key={i} className="bg-yellow-100 text-gray-900 rounded px-0.5">{part}</mark> : part))}
    </p>
  );
}

export default function Search() {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async () => {
    setLoading(true);
    const params: Record<string, string> = { ...filters };
    if (query.trim()) params.q = query.trim();
    api.documents.listAll(params)
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
          placeholder="Search documents, doctors, medicines, values…"
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
          <div>
            <p className="text-xs text-gray-400 mb-3">{docs.length} result{docs.length !== 1 ? 's' : ''}</p>
            {/* Loose vertebrae: results are taken out of the spine and are not in date order. */}
            <SpineLog
              loose
              items={docs.map(doc => ({
                id: doc.id,
                state: doc.reviewed ? 'done' : 'unreviewed',
                children: (
                  <Link
                    to={`/documents/${doc.id}`}
                    className="block bg-white border border-gray-200 rounded-xl p-4 hover:border-blue-300 transition-all"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900">{documentTitle(doc)}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{documentByline(doc)}</p>
                        {doc.snippet && doc.snippet.includes('\u0001') && <Snippet text={doc.snippet} />}
                        {doc.ai_summary && (
                          <p className="text-sm text-gray-500 mt-1 line-clamp-2">{doc.ai_summary}</p>
                        )}
                      </div>
                      <span className="text-xs text-gray-400 shrink-0">p. {doc.page_start}–{doc.page_end}</span>
                    </div>
                  </Link>
                ),
              }))}
            />
          </div>
        )
      )}
    </div>
  );
}
