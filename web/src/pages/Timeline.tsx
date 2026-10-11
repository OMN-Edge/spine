import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api, type Document } from '../api';
import { documentTitle } from '../titles';
import SpineLog from '../components/SpineLog';

const DOC_TYPE_LABELS: Record<string, string> = {
  lab_result: 'Lab',
  discharge_note: 'Discharge',
  vaccination: 'Vaccine',
  imaging: 'Imaging',
  prescription: 'Prescription',
  consultation_note: 'Consultation',
  other: 'Other',
};

const DOC_TYPE_COLORS: Record<string, string> = {
  lab_result: 'bg-blue-100 text-blue-700',
  discharge_note: 'bg-orange-100 text-orange-700',
  vaccination: 'bg-green-100 text-green-700',
  imaging: 'bg-purple-100 text-purple-700',
  prescription: 'bg-yellow-100 text-yellow-700',
  consultation_note: 'bg-teal-100 text-teal-700',
  other: 'bg-gray-100 text-gray-600',
};

function DocCard({ doc }: { doc: Document }) {
  const typeLabel = doc.doc_type ? DOC_TYPE_LABELS[doc.doc_type] ?? doc.doc_type : 'Unknown';
  const typeColor = doc.doc_type ? DOC_TYPE_COLORS[doc.doc_type] ?? 'bg-gray-100 text-gray-600' : 'bg-gray-100 text-gray-600';

  return (
    <Link
      to={`/documents/${doc.id}`}
      className="block bg-white border border-gray-200 rounded-xl p-5 hover:border-blue-300 hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1">
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${typeColor}`}>{typeLabel}</span>
            {!doc.reviewed && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                Unreviewed
              </span>
            )}
          </div>
          <p className="text-sm font-medium text-gray-900 truncate">{documentTitle(doc)}</p>
          {doc.title && doc.provider && <p className="text-xs text-gray-500 truncate">{doc.provider}</p>}
          {doc.ai_summary && (
            <p className="text-sm text-gray-500 mt-1 line-clamp-2">{doc.ai_summary}</p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm text-gray-900">{doc.doc_date ?? '—'}</p>
          <p className="text-xs text-gray-400 mt-0.5">
            p. {doc.page_start}–{doc.page_end}
          </p>
        </div>
      </div>
    </Link>
  );
}

export default function Timeline() {
  const [docs, setDocs] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Record<string, string>>({});

  useEffect(() => {
    setLoading(true);
    api.documents.listAll(filter)
      .then(setDocs)
      .finally(() => setLoading(false));
  }, [filter]);

  // Group by year
  const byYear = docs.reduce<Record<string, Document[]>>((acc, doc) => {
    const year = doc.doc_date ? doc.doc_date.slice(0, 4) : 'Unknown date';
    (acc[year] ??= []).push(doc);
    return acc;
  }, {});
  const years = Object.keys(byYear).sort((a, b) => b.localeCompare(a));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-semibold text-gray-900">Timeline</h1>
        <div className="flex flex-wrap gap-2">
          <select
            className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={filter.doc_type ?? ''}
            onChange={e => setFilter(f => ({ ...f, doc_type: e.target.value || undefined! }))}
          >
            <option value="">All types</option>
            {Object.entries(DOC_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <select
            className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={filter.reviewed ?? ''}
            onChange={e => setFilter(f => ({ ...f, reviewed: e.target.value || undefined! }))}
          >
            <option value="">All</option>
            <option value="false">Unreviewed</option>
            <option value="true">Reviewed</option>
          </select>
        </div>
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">Loading…</p>
      ) : docs.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg mb-2">No documents yet</p>
          <Link to="/upload" className="text-blue-600 text-sm hover:underline">Upload your first file →</Link>
        </div>
      ) : (
        <div className="space-y-8">
          {years.map(year => (
            <div key={year}>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">{year}</h2>
              {/* One spine per year: a reviewed document is a solid vertebra, an unreviewed one an empty amber outline. */}
              <SpineLog
                items={byYear[year].map(doc => ({
                  id: doc.id,
                  state: doc.reviewed ? 'done' : 'unreviewed',
                  children: <DocCard doc={doc} />,
                }))}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
