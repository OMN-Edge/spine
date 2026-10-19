import { useCallback, useEffect, useRef, useState } from 'react';
import { Combobox } from '../components/Combobox';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type UploadDocument, type UploadLayout } from '../api';
import { useOnDataChanged } from '../dataChanged';
import SpineLog from '../components/SpineLog';
import PagePreview from '../components/PagePreview';
import { sourceLabel } from '../components/pageSource';
import { documentByline, documentTitle } from '../titles';
import DeleteUpload from '../components/DeleteUpload';
import { useI18n } from '../i18n';

/**
 * One upload's pages, grouped into the documents they were read as, for fixing the
 * grouping by hand. Between two pages of a document: split it there. Between two
 * documents: join them. Each change reads the documents it touched again (text only, as
 * at upload) and sends them back to review: not at each change but once, when the owner presses Done,
 * so a run of splits and joins costs one reading. The pages' own text is never read again.
 *
 * Page images are the full-size scans, loaded lazily as they scroll into view.
 */
export default function UploadPages() {
  const { t, tn, tx } = useI18n();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [layout, setLayout] = useState<UploadLayout | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<React.ReactNode>('');
  // Which page is open in the big preview, by its position in the upload.
  const [preview, setPreview] = useState<number | null>(null);
  // Documents changed by a split or join and not yet read again. Kept for the tab, so a reload does not forget them.
  const pendingKey = `spine.regroup.${id}`;
  const [pending, setPending] = useState<string[]>(() => {
    try { return JSON.parse(sessionStorage.getItem(pendingKey) ?? '[]') as string[]; } catch { return []; }
  });
  // Before the grouping is confirmed nothing is read, so there is nothing to press Done for: the server marks the documents it changes.
  const unconfirmed = layout?.grouping_confirmed === false;
  const track = (update: (prev: string[]) => string[]) => { if (!unconfirmed) setPending(update); };
  useEffect(() => {
    try { sessionStorage.setItem(pendingKey, JSON.stringify(pending)); } catch { /* the list still works without it */ }
  }, [pendingKey, pending]);
  // A change that would replace what the owner already reviewed waits here for a yes.
  const [confirm, setConfirm] = useState<{ verb: string; button: string; run: () => void; titles: string[] } | null>(null);
  // Dragging a page: which one, and which place it is over.
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    api.sourceFiles.get(id).then(next => {
      setLayout(next);
      // A document that a join absorbed, or that was deleted, is no longer waiting for anything, and neither
      // is one whose every page is now hidden: there is nothing left to read.
      const present = new Set(next.documents.filter(d => !d.hidden).map(d => d.id));
      setPending(prev => (prev.every(docId => present.has(docId)) ? prev : prev.filter(docId => present.has(docId))));
    }).catch(() => setError(t('Upload not found')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(load, [load]);
  // A change made from the chat (a page moved, documents combined, a grouping confirmed): read the layout again.
  useOnDataChanged(load);

  /** Splits or joins. If a document that was reviewed is affected, ask first: it is read again, which replaces its details. */
  const ask = (label: string, docId: string, body: Parameters<typeof api.documents.boundary>[1], affected: UploadDocument[]) => {
    const reviewed = affected.filter(d => d.reviewed);
    if (reviewed.length === 0) { regroup(label, docId, body); return; }
    setNotice('');
    setConfirm({ verb: label === 'Joining' ? t('Joining') : t('Splitting'), button: label === 'Joining' ? t('Join anyway') : t('Split anyway'), run: () => regroup(label, docId, body), titles: reviewed.map(d => documentTitle(d, t)) });
  };

  type MoveBody = Parameters<typeof api.sourceFiles.movePage>[1];

  /** Dropping a page. Moving it sends the documents it leaves and joins back to review, so a reviewed one is asked about first. */
  const dropPage = (target: MoveBody, chosen?: string) => {
    const pageId = chosen ?? dragging;
    setDragging(null);
    setOver(null);
    if (!pageId || !layout) return;
    const page = layout.pages.find(p => p.id === pageId);
    const origin = layout.documents.find(d => page && page.page_number >= d.page_start && page.page_number <= d.page_end);
    const destination = 'document_id' in target ? layout.documents.find(d => d.id === target.document_id) : undefined;
    const reviewed = [...new Set([origin, destination])].filter((d): d is UploadDocument => !!d && !!d.reviewed);
    if (reviewed.length === 0) { movePage(pageId, target); return; }
    setNotice('');
    setConfirm({ verb: t('Moving this page'), button: t('Move anyway'), run: () => movePage(pageId, target), titles: reviewed.map(d => documentTitle(d, t)) });
  };

  const movePage = async (pageId: string, target: MoveBody) => {
    setConfirm(null);
    setBusy(t('Moving the page'));
    setNotice('');
    try {
      const result = await api.sourceFiles.movePage(pageId, target);
      if (!result.moved) {
        setNotice(t('The page is already there.'));
      } else {
        track(prev => [...new Set([...prev, ...result.touched])].filter(docId => !result.deleted.includes(docId)));
        setNotice(
          result.deleted.length > 0
            ? (unconfirmed ? t('Page moved. Its document had no other pages, so it was folded into where the page went. Keep going, then confirm the grouping when it is right.') : t('Page moved. Its document had no other pages, so it was folded into where the page went. Press Done to read the changed documents.'))
            : (unconfirmed ? t('Saved. Keep grouping, then confirm the grouping when it is right.') : t('Page moved. Keep going, then press Done to read the changed documents.')),
        );
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t('Could not move the page'));
    } finally {
      setBusy('');
      load();
    }
  };

  const regroup = async (label: string, docId: string, body: Parameters<typeof api.documents.boundary>[1]) => {
    setConfirm(null);
    setBusy(label === 'Joining' ? t('Joining') : t('Splitting'));
    setNotice('');
    try {
      const result = (await api.documents.boundary(docId, { ...body, defer: true })) as { split_into?: string[]; merged?: string };
      const touched = result.split_into ?? (result.merged ? [result.merged] : []);
      const absorbed = body.action === 'merge' ? body.with_document_id : null;
      track(prev => [...new Set([...prev, ...touched])].filter(docId => docId !== absorbed));
      setNotice(unconfirmed ? t('Saved. Keep grouping, then confirm the grouping when it is right.') : t('Saved. Keep grouping, then press Done to read the changed documents.'));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t('Could not change the grouping'));
    } finally {
      setBusy('');
      load();
    }
  };

  /** Set a page aside, or bring it back. Either way the documents that hold it need reading again. */
  const setHidden = async (pageId: string, hidden: boolean) => {
    setNotice('');
    try {
      const result = await api.sourceFiles.setPageHidden(pageId, hidden);
      track(prev => [...new Set([...prev, ...result.document_ids])]);
      setNotice(unconfirmed ? t('Saved. Keep grouping, then confirm the grouping when it is right.') : hidden ? t('Page set aside. Press Done to read the document again without it.') : t('Page brought back. Press Done to read the document again with it.'));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t('Could not change the page'));
    } finally {
      load();
    }
  };

  /** Set a whole document aside, however many pages it has, or bring all of them back. */
  const setDocumentHidden = async (doc: UploadDocument, hidden: boolean) => {
    setBusy(hidden ? t('Hiding the document') : t('Showing the pages'));
    setNotice('');
    try {
      await api.documents.setHidden(doc.id, hidden);
      // Hidden, there is nothing left to read. Shown again, its pages may differ from what its details were read from.
      track(prev => hidden ? prev.filter(docId => docId !== doc.id) : [...new Set([...prev, doc.id])]);
      setNotice(hidden
        ? t('Document hidden. It is left out of the timeline, search and shares. Use Show all pages to bring it back.')
        : t('Pages shown. Press Done to read the document again with them.'));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t('Could not change the document'));
    } finally {
      setBusy('');
      load();
    }
  };

  /** Where a dragged page can land. It lights up while a page is over it and takes the drop. Inner places win over outer ones. */
  const zone = (key: string, target: MoveBody) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (over !== key) setOver(key);
    },
    onDragLeave: () => setOver(o => (o === key ? null : o)),
    onDrop: (e: React.DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      dropPage(target);
    },
  });

  // After "Grouping is right" the documents are read, which takes a while; the screen asks again until it is over.
  const reading = layout?.reading ?? null;
  const started = useRef(false);
  useEffect(() => {
    if (reading?.status !== 'running') return;
    const timer = window.setTimeout(load, 2500);
    return () => window.clearTimeout(timer);
  }, [reading?.status, reading?.read, layout, load]);
  useEffect(() => {
    if (started.current && reading?.status === 'done' && layout?.grouping_confirmed) {
      started.current = false;
      setNotice(<>{tx('Grouping confirmed. The documents were read and are in your timeline and waiting in {review}.', { review: <Link to="/review" className="text-blue-600 hover:underline">{t('Review')}</Link> })}</>);
    }
  }, [reading?.status, layout?.grouping_confirmed, tx, t]);

  const confirmGrouping = async () => {
    if (!id) return;
    setBusy(t('Confirming the grouping'));
    setNotice('');
    try {
      const result = await api.sourceFiles.confirmGrouping(id);
      if (result.confirmed) {
        setNotice(<>{tx('Grouping confirmed. The documents are in your timeline and waiting in {review}.', { review: <Link to="/review" className="text-blue-600 hover:underline">{t('Review')}</Link> })}</>);
      } else {
        started.current = true;
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t('Could not confirm the grouping'));
    } finally {
      setBusy('');
      load();
    }
  };

  const finish = async () => {
    if (!id || pending.length === 0) return;
    setBusy(t('Reading the changed documents'));
    setNotice('');
    try {
      const { results } = await api.sourceFiles.extract(id, pending);
      const failed = results.filter(r => r.reread === 'failed').map(r => r.id);
      // A document with every page hidden has nothing to read: it is not waiting for anything.
      const skipped = results.filter(r => r.reread === 'skipped').length;
      const read = results.length - failed.length - skipped;
      setPending(failed);
      const hidden = skipped > 0 && <> {tn(skipped, '{n} document has every page hidden, so nothing was read for it.', '{n} documents have every page hidden, so nothing was read for them.')}</>;
      setNotice(
        failed.length === 0
          ? <>{t('Done.')}{read > 0 && (layout?.grouping_confirmed === false
              ? <> {t('The changed documents were read again. Confirm the grouping when it is right.')}</>
              : <> {tx('The changed documents were read again and are waiting in {review}.', { review: <Link to="/review" className="text-blue-600 hover:underline">{t('Review')}</Link> })}</>)}{hidden}</>
          : <>{tn(failed.length, '{read} read again; {n} could not be, so its details are from before. Press Done to try again.', '{read} read again; {n} could not be, so their details are from before. Press Done to try again.', { read })}{hidden}</>,
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : t('Could not read the changed documents'));
    } finally {
      setBusy('');
      load();
    }
  };

  if (error) return <p className="text-red-500 text-sm">{error}</p>;
  if (!layout) return <p className="text-gray-400 text-sm">{t('Loading…')}</p>;

  const pagesOf = (doc: UploadDocument) =>
    layout.pages.filter(p => p.page_number >= doc.page_start && p.page_number <= doc.page_end);

  return (
        <div className="max-w-4xl mx-auto">
      <Link to="/upload" className="text-sm text-gray-500 hover:text-gray-700">← {t('Uploads')}</Link>
      <h1 className="text-2xl font-semibold text-gray-900 mt-2">{t('Pages and grouping')}</h1>
      <p className="text-sm text-gray-500 mt-1 mb-6">
        {t('Uploaded {date}', { date: layout.uploaded_at.slice(0, 10) })} · {tn(layout.pages.length, '{n} page', '{n} pages')} ·{' '}
        {tn(layout.documents.length, '{n} document', '{n} documents')}.{' '}
        {unconfirmed ? t('Split a document between two pages, join it to the one before, or drag a page to another place or document. Nothing is read until you confirm the grouping.') : t('Split a document between two pages, join it to the one before, or drag a page to another place or document. Nothing is read again until you press Done.')}
      </p>
      <div className="flex flex-wrap text-sm -mt-4 mb-6">
        <DeleteUpload fileId={layout.id} documents={layout.documents.length} label={t('Delete this upload')} onDeleted={() => navigate('/upload')} />
      </div>

      {confirm && (
        <div role="alertdialog" aria-label={t('Replace reviewed details?')} className="mb-4 bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm">
          <p className="text-amber-900">
            {tx('{verb} sends the changed documents back to Review, and reading them again when you press Done {replaces} in {titles}.', {
              verb: confirm.verb,
              replaces: <strong>{t('replaces the details you reviewed')}</strong>,
              titles: confirm.titles.map((title, i) => <span key={i}>{i > 0 && ', '}“{title}”</span>),
            })}
          </p>
          <div className="flex gap-2 mt-3">
            <button type="button" onClick={confirm.run} className="bg-blue-600 text-white rounded-lg px-3 py-1.5 text-sm hover:bg-blue-700">
              {confirm.button}
            </button>
            <button type="button" onClick={() => setConfirm(null)} className="px-3 py-1.5 rounded-lg text-sm text-gray-600 border border-gray-300 hover:bg-white">{t('Cancel')}</button>
          </div>
        </div>
      )}

      {layout.status === 'done' && layout.grouping_confirmed === false && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm">
          <p className="font-medium text-amber-900">{t('Is this grouping right?')}</p>
          <p className="text-amber-900 mt-1">
            {t('Look at which pages the documents hold. Split, join or move pages if it is wrong. Until you confirm it, these documents stay out of your timeline, search, shares and trends, and cannot be marked reviewed.')}
          </p>
          <p className="text-amber-900 mt-1">{t('Nothing is read from the documents until you confirm, so changing the grouping costs nothing.')}</p>
          {reading?.status === 'running' && (
            <p className="mt-2 text-blue-800" role="status">{t('Reading the documents… {read} of {total}', { read: reading.read, total: reading.documents })}</p>
          )}
          {reading?.status === 'failed' && (
            <p className="mt-2 text-red-600" role="alert">{t('The documents could not be read. Press “Grouping is right” to try again.')}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button" onClick={confirmGrouping} disabled={!!busy || pending.length > 0 || layout.documents.length === 0 || reading?.status === 'running'}
              className="bg-blue-600 text-white rounded-lg px-4 py-1.5 text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {t('Grouping is right')}
            </button>
            {pending.length > 0 && <span className="text-xs text-amber-800">{t('Press Done below first, so the changed documents are read again.')}</span>}
          </div>
        </div>
      )}

      {pending.length > 0 && (
        <div className="mb-4 bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm flex flex-wrap items-center justify-between gap-3">
          <p className="text-blue-900">
            {tn(pending.length, '{n} document changed. Press Done when you have finished grouping, and its details will be read again once.', '{n} documents changed. Press Done when you have finished grouping, and their details will be read again once.')}
          </p>
          <button type="button" disabled={!!busy} onClick={finish} className="bg-blue-600 text-white rounded-lg px-4 py-1.5 text-sm hover:bg-blue-700 disabled:opacity-50">
            {t('Done')}
          </button>
        </div>
      )}

      <div aria-live="polite" className="min-h-[1.5rem] mb-4 text-sm space-y-2">
        {busy ? <span className="text-blue-700">{busy}…</span> : notice && <span className="text-gray-700">{notice}</span>}
      </div>

      {layout.documents.length === 0 ? (
        <p className="text-gray-400 text-sm">{t('This upload produced no documents.')}</p>
      ) : (
        <SpineLog
          items={layout.documents.map((doc, index) => ({
            id: doc.id,
            state: doc.reviewed ? 'done' : 'unreviewed',
            children: (
              <>
              {dragging && (
                <div
                  {...zone(`new:${doc.id}`, { new_document: true, before_document_id: doc.id })}
                  className={`mb-2 rounded-lg border-2 border-dashed px-3 py-2 text-center text-xs transition-colors ${over === `new:${doc.id}` ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-300 text-gray-400'}`}
                >
                  {t('Drop here to make it a document of its own')}
                </div>
              )}
              <div className={`rounded-xl border overflow-hidden ${doc.hidden ? 'border-dashed border-gray-400 bg-gray-100' : 'border-gray-200 bg-white'}`}>
                {doc.hidden && (
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-gray-200 px-4 py-2.5 text-xs text-gray-700">
                    <p className="flex items-start gap-2 min-w-0">
                      <svg viewBox="0 0 24 24" className="h-4 w-4 mt-px shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A9.8 9.8 0 0112 5c5 0 9 4 10 7a11 11 0 01-3 4.2M6.6 6.6A11 11 0 002 12c1 3 5 7 10 7a9.7 9.7 0 004.1-.9" />
                      </svg>
                      <span><strong className="font-semibold">{t('Hidden.')}</strong> {t('Every page is hidden, so this document is left out of the timeline, search and shares.')}</span>
                    </p>
                    <button
                      type="button" disabled={!!busy} onClick={() => setDocumentHidden(doc, false)}
                      className="shrink-0 rounded-lg border border-gray-400 bg-white px-2.5 py-1 text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                    >
                      {t('Show all pages')}
                    </button>
                  </div>
                )}
                <div className={`p-4 ${doc.hidden ? 'text-gray-500' : ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
                  <div className="min-w-0">
                    <Link to={`/documents/${doc.id}`} className={`text-sm font-medium hover:text-blue-700 ${doc.hidden ? 'text-gray-600' : 'text-gray-900'}`}>
                      {doc.needs_reading && !doc.title && doc.title_guess ? <span className="italic" title={t('A guess from the first line of its first page. The real title comes when the document is read.')}>{doc.title_guess}</span> : documentTitle(doc, t)}
                    </Link>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {[documentByline(doc, t), doc.page_start === doc.page_end ? t('page {n}', { n: doc.page_start }) : t('pages {from}–{to}', { from: doc.page_start, to: doc.page_end })]
                        .filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  {index > 0 && (
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => ask('Joining', layout.documents[index - 1].id, { action: 'merge', with_document_id: doc.id }, [layout.documents[index - 1], doc])}
                      className="shrink-0 text-xs text-blue-600 border border-blue-200 rounded-lg px-2.5 py-1 hover:bg-blue-50 disabled:opacity-50"
                    >
                      {t('Join with previous')}
                    </button>
                  )}
                </div>

                <div
                  className={`flex flex-wrap items-stretch gap-y-3 rounded-lg ${over === `end:${doc.id}` ? 'bg-blue-50 ring-2 ring-blue-300' : ''}`}
                  {...zone(`end:${doc.id}`, { document_id: doc.id, before_page_id: null })}
                >
                  {pagesOf(doc).map((page, i) => {
                    const here = `${doc.id}:${page.id}`;
                    return (
                      <div key={page.id} className="flex items-stretch">
                        {/* The place before this page: where a split goes, and where a dragged page can be dropped. */}
                        <div
                          {...zone(here, { document_id: doc.id, before_page_id: page.id })}
                          className={`flex items-stretch rounded transition-all ${dragging ? (over === here ? 'w-8 bg-blue-200' : 'w-4 bg-gray-100') : ''}`}
                        >
                          {i > 0 && !dragging && (
                            <button
                              type="button"
                              disabled={!!busy}
                              onClick={() => ask('Splitting', doc.id, { action: 'split', at_page: page.page_number }, [doc])}
                              aria-label={t('Split before page {n}', { n: page.page_number })}
                              title={t('Split before page {n}', { n: page.page_number })}
                              className="group mx-1 w-10 sm:w-6 flex flex-col items-center justify-center text-gray-300 hover:text-blue-600 focus:text-blue-600 disabled:opacity-40"
                            >
                              <span className="flex-1 border-l-2 border-dashed border-current" aria-hidden="true" />
                              <svg viewBox="0 0 24 24" className="h-4 w-4 my-1" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
                                <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M8.1 8.1 20 20M8.1 15.9 20 4" />
                              </svg>
                              <span className="flex-1 border-l-2 border-dashed border-current" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                        <figure
                          draggable={!busy}
                          onDragStart={e => {
                            e.dataTransfer.setData('text/plain', page.id);
                            e.dataTransfer.effectAllowed = 'move';
                            // After the drag has started: changing the page while it starts can cancel it in some browsers.
                            window.setTimeout(() => setDragging(page.id), 0);
                          }}
                          onDragEnd={() => { setDragging(null); setOver(null); }}
                          {...zone(here, { document_id: doc.id, before_page_id: page.id })}
                          className={`w-20 sm:w-24 ${busy ? '' : 'cursor-grab active:cursor-grabbing'} ${page.hidden ? 'opacity-50' : ''} ${dragging === page.id ? 'opacity-30' : ''}`}
                        >
                          {/* A div, not a button: a button swallows the drag in some browsers. */}
                          <div
                            role="button" tabIndex={0}
                            onClick={() => setPreview(layout.pages.findIndex(p => p.id === page.id))}
                            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPreview(layout.pages.findIndex(p => p.id === page.id)); } }}
                            aria-label={t('Open page {n} larger', { n: page.page_number })}
                            className="block w-full rounded focus:outline-none focus:ring-2 focus:ring-blue-500 hover:ring-2 hover:ring-blue-200"
                          >
                            <img
                              src={`/api/pages/${page.id}/image`}
                              alt=""
                              loading="lazy"
                              draggable={false}
                              width={page.image_width}
                              height={page.image_height}
                              className="w-full h-auto rounded border border-gray-200 bg-gray-50"
                            />
                          </div>
                          <figcaption
                            className="text-[11px] text-gray-400 text-center mt-1"
                            title={page.source_page !== page.page_number ? t('Page {n} of the file, moved here', { n: page.source_page }) : undefined}
                          >
                            {page.page_number}
                            {page.source_page !== page.page_number && <span className="text-blue-500">*</span>}
                            {page.extraction_source && page.extraction_source !== 'native_text' && (
                              <span className={`ml-1 ${page.extraction_source === 'multimodal' ? 'text-purple-600' : 'text-amber-600'}`}>
                                · {t(sourceLabel(page.extraction_source))}
                              </span>
                            )}
                          </figcaption>
                          <button
                            type="button" disabled={!!busy} onClick={() => setHidden(page.id, !page.hidden)}
                            className="block w-full text-center text-[11px] text-gray-400 hover:text-gray-700 hover:underline disabled:opacity-50"
                          >
                            {page.hidden ? t('Show') : t('Hide')}
                          </button>
                        </figure>
                      </div>
                    );
                  })}
                  {/* After the last page of the document. */}
                  {dragging && (
                    <div
                      {...zone(`last:${doc.id}`, { document_id: doc.id, before_page_id: null })}
                      className={`ml-1 rounded transition-all ${over === `last:${doc.id}` ? 'w-8 bg-blue-200' : 'w-4 bg-gray-100'}`}
                    />
                  )}
                </div>

                <div className="mt-3 pt-3 border-t border-gray-100 flex flex-wrap items-start gap-x-6 gap-y-2">
                  <Link to={`/documents/${doc.id}`} className="text-xs text-blue-600 hover:underline">{t('View document')}</Link>
                  {!doc.hidden && (
                    <button type="button" disabled={!!busy} onClick={() => setDocumentHidden(doc, true)} className="text-xs text-gray-500 hover:text-gray-800 hover:underline disabled:opacity-50">
                      {t('Hide document')}
                    </button>
                  )}
                  {pending.includes(doc.id) && <span className="text-xs text-amber-700">{t('Changed, waiting for Done')}</span>}
                  {unconfirmed && doc.needs_reading && <span className="text-xs text-gray-500">{t('Not read yet')}</span>}
                </div>
                </div>
              </div>
              </>
            ),
          }))}
        />
      )}
      {dragging && (
        <div
          {...zone('new:end', { new_document: true, before_document_id: null })}
          className={`mt-2 rounded-lg border-2 border-dashed px-3 py-2 text-center text-xs transition-colors ${over === 'new:end' ? 'border-blue-400 bg-blue-50 text-blue-700' : 'border-gray-300 text-gray-400'}`}
        >
          {t('Drop here to make it the last document')}
        </div>
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
            return (
              <div className="flex flex-col items-center gap-3 w-full max-w-sm">
                {doc && (
                  <Link to={`/documents/${doc.id}?page=${page.page_number}`} className="text-sm text-blue-300 hover:text-blue-200">
                    {t('Open this page in its document')} →
                  </Link>
                )}
                {/* Dragging does not work on a touch screen: this is the same move, chosen from a list. */}
                {!busy && (
                  <Combobox
                    className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white text-gray-900" ariaLabel={t('Move this page to…')} placeholder={t('Move this page to…')} value=""
                    options={[
                      ...layout.documents.filter(d => d.id !== doc?.id).map(d => ({ value: d.id, label: documentTitle(d, t), hint: `${d.page_start}–${d.page_end}` })),
                      { value: '__own__', label: t('A document of its own') },
                    ]}
                    onChange={v => {
                      setPreview(null);
                      dropPage(v === '__own__' ? { new_document: true, before_document_id: null } : { document_id: v, before_page_id: null }, page.id);
                    }}
                  />
                )}
              </div>
            );
          }}
          caption={page => {
            const doc = layout.documents.find(d => page.page_number >= d.page_start && page.page_number <= d.page_end);
            return doc ? documentTitle(doc, t) : t('Not part of a document');
          }}
        />
      )}
    </div>
  );
}
