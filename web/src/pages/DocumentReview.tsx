import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, type Document, type ExtractedField, type Page } from '../api';
import PageImageOverlay from '../components/PageImageOverlay';

export default function DocumentReview() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [doc, setDoc] = useState<Document | null>(null);
  const [loading, setLoading] = useState(true);
  const [hoveredField, setHoveredField] = useState<ExtractedField | null>(null);
  const [currentPageIdx, setCurrentPageIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [edits, setEdits] = useState<Partial<Document>>({});

  useEffect(() => {
    if (!id) return;
    api.documents.get(id)
      .then(d => { setDoc(d); setEdits({}); })
      .finally(() => setLoading(false));
  }, [id]);

  // When a field is hovered, switch to its page automatically
  useEffect(() => {
    if (!hoveredField || !doc?.pages) return;
    const idx = doc.pages.findIndex(p => p.id === hoveredField.page_id);
    if (idx >= 0) setCurrentPageIdx(idx);
  }, [hoveredField, doc?.pages]);

  const save = async () => {
    if (!id || !doc) return;
    setSaving(true);
    await api.documents.update(id, { ...edits, reviewed: true });
    setSaving(false);
    navigate('/review');
  };

  if (loading) return <p className="text-gray-400 text-sm">Loading…</p>;
  if (!doc) return <p className="text-red-500 text-sm">Document not found</p>;

  const pages: Page[] = doc.pages ?? [];
  const fields: ExtractedField[] = doc.fields ?? [];
  const currentPage = pages[currentPageIdx];

  const fieldGroups = [
    { key: 'doc_date', label: 'Date', value: edits.doc_date ?? doc.doc_date ?? '', editable: true },
    { key: 'provider', label: 'Provider', value: edits.provider ?? doc.provider ?? '', editable: true },
    { key: 'doc_type', label: 'Type', value: edits.doc_type ?? doc.doc_type ?? '', editable: true },
  ];

  return (
    <div className="flex gap-6 h-[calc(100vh-8rem)]">
      {/* Left panel */}
      <div className="w-80 shrink-0 overflow-y-auto flex flex-col gap-4">
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-medium text-gray-900">Document</h2>
            <button
              onClick={() => navigate(-1)}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              ← Back
            </button>
          </div>

          {fieldGroups.map(f => (
            <div key={f.key} className="mb-3">
              <label className="block text-xs font-medium text-gray-500 mb-1">{f.label}</label>
              <input
                type="text"
                value={f.value}
                onChange={e => setEdits(prev => ({ ...prev, [f.key]: e.target.value }))}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          ))}

          <div className="mb-3">
            <label className="block text-xs font-medium text-gray-500 mb-1">Summary</label>
            <p className="text-xs text-gray-600 leading-relaxed">{doc.ai_summary}</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Notes</label>
            <textarea
              value={edits.user_notes ?? doc.user_notes ?? ''}
              onChange={e => setEdits(prev => ({ ...prev, user_notes: e.target.value }))}
              rows={3}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="Personal notes…"
            />
          </div>
        </div>

        {/* Extracted fields */}
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <h3 className="font-medium text-gray-900 mb-3 text-sm">Extracted fields</h3>
          {fields.length === 0 ? (
            <p className="text-xs text-gray-400">No fields extracted</p>
          ) : (
            <div className="space-y-1">
              {fields.map(field => (
                <div
                  key={field.id}
                  onMouseEnter={() => setHoveredField(field)}
                  onMouseLeave={() => setHoveredField(null)}
                  className={`
                    flex items-start justify-between gap-2 p-2 rounded-lg cursor-default transition-colors text-xs
                    ${hoveredField?.id === field.id ? 'bg-yellow-50 border border-yellow-200' : 'hover:bg-gray-50'}
                  `}
                >
                  <span className="font-medium text-gray-500 shrink-0">{field.label}</span>
                  <span className="text-gray-900 text-right">{field.value}</span>
                  {field.bbox_x0 === null && (
                    <span className="text-gray-300" title="Source not pinpointed">◌</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={save}
          disabled={saving}
          className="bg-blue-600 text-white rounded-xl px-4 py-2.5 font-medium text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Mark as reviewed'}
        </button>
      </div>

      {/* Right panel — page images */}
      <div className="flex-1 overflow-y-auto">
        {pages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400">
            <p>No page images available yet</p>
          </div>
        ) : (
          <>
            {pages.length > 1 && (
              <div className="flex gap-1 mb-3">
                {pages.map((p, i) => (
                  <button
                    key={p.id}
                    onClick={() => setCurrentPageIdx(i)}
                    className={`text-xs px-2 py-1 rounded ${
                      i === currentPageIdx
                        ? 'bg-blue-600 text-white'
                        : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {p.page_number}
                  </button>
                ))}
              </div>
            )}

            {currentPage && (
              <PageImageOverlay page={currentPage} highlightField={hoveredField} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
