import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type UploadDocument, type UploadLayout } from '../api';
import SpineLog from '../components/SpineLog';
import PagePreview from '../components/PagePreview';
import { ExtractAgainButton } from '../components/AiReading';
import { sourceLabel } from '../components/pageSource';
import { documentByline, documentTitle } from '../titles';

/**
 * One upload's pages, grouped into the documents they were read as, for fixing the
 * grouping by hand. Between two pages of a document: split it there. Between two
 * documents: join them. Each change reads the documents it touched again (text only, as
 * at upload) and sends them back to review.
 *
 * Page images are the full-size scans, loaded lazily as they scroll into view.
 */
export default function UploadPages() {
  const { id } = useParams<{ id: string }>();
  const [layout, setLayout] = useState<UploadLayout | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<React.ReactNode>('');
  // Which page is open in the big preview, by its position in the upload.
  const [preview, setPreview] = useState<number | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    api.sourceFiles.get(id).then(setLayout).catch(() => setError('Upload not found'));
  }, [id]);
  useEffect(load, [load]);

  const regroup = async (label: string, docId: string, body: Parameters<typeof api.documents.boundary>[1]) => {
    setBusy(label);
    setNotice('');
    try {
      const result = (await api.documents.boundary(docId, body)) as { reread?: string };
      setNotice(
        <>
          {result.reread === 'failed'
            ? 'Saved. The changed documents could not be read again, so their details are from before. '
            : 'Saved. The changed documents were read again. '}
          They are waiting in{' '}
          <Link to="/review" className="text-blue-600 hover:underline">Review</Link>.
        </>,
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not change the grouping');
    } finally {
      setBusy('');
      load();
    }
  };

  if (error) return <p className="text-red-500 text-sm">{error}</p>;
  if (!layout) return <p className="text-gray-400 text-sm">Loading…</p>;

  const pagesOf = (doc: UploadDocument) =>
    layout.pages.filter(p => p.page_number >= doc.page_start && p.page_number <= doc.page_end);

  return (
        <div className="max-w-4xl mx-auto">
      <Link to="/upload" className="text-sm text-gray-500 hover:text-gray-700">← Uploads</Link>
      <h1 className="text-2xl font-semibold text-gray-900 mt-2">Pages and grouping</h1>
      <p className="text-sm text-gray-500 mt-1 mb-6">
        Uploaded {layout.uploaded_at.slice(0, 10)} · {layout.pages.length} page{layout.pages.length === 1 ? '' : 's'} ·{' '}
        {layout.documents.length} document{layout.documents.length === 1 ? '' : 's'}.
        Split a document between two pages, or join it to the one before.
      </p>

      <div aria-live="polite" className="min-h-[1.5rem] mb-4 text-sm space-y-2">
        {busy ? <span className="text-blue-700">{busy}…</span> : notice && <span className="text-gray-700">{notice}</span>}
      </div>

      {layout.documents.length === 0 ? (
        <p className="text-gray-400 text-sm">This upload produced no documents.</p>
      ) : (
        <SpineLog
          items={layout.documents.map((doc, index) => ({
            id: doc.id,
            state: doc.reviewed ? 'done' : 'unreviewed',
            children: (
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
                  <div className="min-w-0">
                    <Link to={`/documents/${doc.id}`} className="text-sm font-medium text-gray-900 hover:text-blue-700">
                      {documentTitle(doc)}
                    </Link>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {[documentByline(doc), doc.page_start === doc.page_end ? `page ${doc.page_start}` : `pages ${doc.page_start}–${doc.page_end}`]
                        .filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  {index > 0 && (
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => regroup('Joining', layout.documents[index - 1].id, { action: 'merge', with_document_id: doc.id })}
                      className="shrink-0 text-xs text-blue-600 border border-blue-200 rounded-lg px-2.5 py-1 hover:bg-blue-50 disabled:opacity-50"
                    >
                      Join with previous
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-stretch gap-y-3">
                  {pagesOf(doc).map((page, i) => (
                    <div key={page.id} className="flex items-stretch">
                      {i > 0 && (
                        <button
                          type="button"
                          disabled={!!busy}
                          onClick={() => regroup('Splitting', doc.id, { action: 'split', at_page: page.page_number })}
                          aria-label={`Split before page ${page.page_number}`}
                          title={`Split before page ${page.page_number}`}
                          className="group mx-1 w-10 sm:w-6 flex flex-col items-center justify-center text-gray-300 hover:text-blue-600 focus:text-blue-600 disabled:opacity-40"
                        >
                          <span className="flex-1 border-l-2 border-dashed border-current" aria-hidden="true" />
                          <svg viewBox="0 0 24 24" className="h-4 w-4 my-1" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
                            <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M8.1 8.1 20 20M8.1 15.9 20 4" />
                          </svg>
                          <span className="flex-1 border-l-2 border-dashed border-current" aria-hidden="true" />
                        </button>
                      )}
                      <figure className="w-20 sm:w-24">
                        <button
                          type="button"
                          onClick={() => setPreview(layout.pages.findIndex(p => p.id === page.id))}
                          aria-label={`Open page ${page.page_number} larger`}
                          className="block w-full rounded focus:outline-none focus:ring-2 focus:ring-blue-500 hover:ring-2 hover:ring-blue-200"
                        >
                          <img
                            src={`/api/pages/${page.id}/image`}
                            alt=""
                            loading="lazy"
                            width={page.image_width}
                            height={page.image_height}
                            className="w-full h-auto rounded border border-gray-200 bg-gray-50"
                          />
                        </button>
                        <figcaption className="text-[11px] text-gray-400 text-center mt-1">
                          {page.page_number}
                          {page.extraction_source && page.extraction_source !== 'native_text' && (
                            <span className={`ml-1 ${page.extraction_source === 'multimodal' ? 'text-purple-600' : 'text-amber-600'}`}>
                              · {sourceLabel(page.extraction_source)}
                            </span>
                          )}
                        </figcaption>
                      </figure>
                    </div>
                  ))}
                </div>

                <div className="mt-3 pt-3 border-t border-gray-100 flex flex-wrap items-start gap-x-6 gap-y-2">
                  <ExtractAgainButton
                    documentId={doc.id}
                    reviewed={!!doc.reviewed}
                    onDone={result => {
                      setNotice(result === 'failed'
                        ? 'The details could not be extracted again, so they are as they were.'
                        : 'Extracted again. The document is waiting in Review.');
                      load();
                    }}
                  />
                </div>
              </div>
            ),
          }))}
        />
      )}

      {preview !== null && (
        <PagePreview
          pages={layout.pages}
          index={preview}
          onIndex={setPreview}
          onClose={() => setPreview(null)}
          extras={page => {
            const doc = layout.documents.find(d => page.page_number >= d.page_start && page.page_number <= d.page_end);
            // The preview only shows. What was extracted from the page, and reading it again, are on the document.
            return doc ? (
              <Link to={`/documents/${doc.id}?page=${page.page_number}`} className="text-sm text-blue-300 hover:text-blue-200">
                Open this page in its document →
              </Link>
            ) : null;
          }}
          caption={page => {
            const doc = layout.documents.find(d => page.page_number >= d.page_start && page.page_number <= d.page_end);
            return doc ? documentTitle(doc) : 'Not part of a document';
          }}
        />
      )}
    </div>
  );
}
