import { useState, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api, type Document } from '../api';
import { documentByline, documentTitle } from '../titles';
import SpineLog from '../components/SpineLog';
import { msg, useI18n } from '../i18n';
import { useScreen } from '../components/ChatProvider';

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
  const { t, tn } = useI18n();
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [docs, setDocs] = useState<Document[] | null>(null);
  const [loading, setLoading] = useState(false);
  // Documents can be found by what they mean as well as by their words, where the server has that switched on.
  const [canMeaning, setCanMeaning] = useState(false);
  const [byMeaning, setByMeaning] = useState(false);
  useEffect(() => { api.sourceFiles.capabilities().then(c => setCanMeaning(!!c.similarity?.enabled)).catch(() => {}); }, []);

  useScreen({ page: 'search', query: query.trim().slice(0, 300) || undefined, documentIds: (docs ?? []).slice(0, 30).map(d => d.id), filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as Record<string, string> });

  const search = useCallback(async () => {
    setLoading(true);
    // By words and meaning together: the filters below are for the word search, so they are not offered with it.
    if (byMeaning && query.trim()) {
      api.documents.hybrid(query.trim()).then(setDocs).catch(() => setDocs([])).finally(() => setLoading(false));
      return;
    }
    const params: Record<string, string> = { ...filters };
    if (query.trim()) params.q = query.trim();
    api.documents.listAll(params)
      .then(setDocs)
      .finally(() => setLoading(false));
  }, [query, filters, byMeaning]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') search();
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900 mb-6">{t('Search')}</h1>

      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={t('Search documents, doctors, medicines, values…')}
          className="flex-1 border border-gray-300 rounded-xl px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          autoFocus
        />
        <button
          onClick={search}
          className="bg-blue-600 text-white rounded-xl px-5 py-2 font-medium hover:bg-blue-700"
        >
          {t('Search')}
        </button>
      </div>

      {canMeaning && (
        <label className="flex items-center gap-2 text-sm text-gray-600 mb-4">
          <input type="checkbox" checked={byMeaning} onChange={e => setByMeaning(e.target.checked)} />
          {t('Also find documents that mean the same, not only the same words')}
        </label>
      )}

      <div className={`flex flex-wrap gap-2 mb-6 ${byMeaning ? 'hidden' : ''}`}>
        {[
          ['tag', msg('Tag'), ''],
          ['doc_type', msg('Type'), ''],
          ['date_from', msg('From'), ''],
          ['date_to', msg('To'), ''],
        ].map(([key, label]) => (
          <div key={key} className="flex items-center gap-1">
            <label className="text-xs text-gray-500">{t(label)}</label>
            <input
              type={key.startsWith('date') ? 'date' : 'text'}
              value={filters[key] ?? ''}
              onChange={e => setFilters(f => ({ ...f, [key]: e.target.value || undefined! }))}
              className="text-sm border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={key === 'tag' ? t('e.g. allergy') : key === 'doc_type' ? t('e.g. lab_result') : ''}
            />
          </div>
        ))}
      </div>

      {loading && <p className="text-gray-400 text-sm">{t('Searching…')}</p>}

      {docs !== null && !loading && (
        docs.length === 0 ? (
          <p className="text-gray-400 text-sm">{t('No results')}</p>
        ) : (
          <div>
            <p className="text-xs text-gray-400 mb-3">{tn(docs.length, '{n} result', '{n} results')}</p>
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
                        <p className="text-sm font-medium text-gray-900">{documentTitle(doc, t)}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{documentByline(doc, t)}</p>
                        {doc.snippet && doc.snippet.includes('\u0001') && <Snippet text={doc.snippet} />}
                        {doc.ai_summary && (
                          <p className="text-sm text-gray-500 mt-1 line-clamp-2">{doc.ai_summary}</p>
                        )}
                      </div>
                      <span className="text-xs text-gray-400 shrink-0">{t('p. {from}–{to}', { from: doc.page_start, to: doc.page_end })}</span>
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
