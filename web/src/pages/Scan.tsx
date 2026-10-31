import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import CornerEditor from '../scan/CornerEditor';
import { defaultQuad, detectDocument } from '../scan/detect';
import type { Quad } from '../scan/image';
import { loadRaster, processPage, type Loaded, type PageFilter } from '../scan/process';
import { useChat } from '../components/ChatProvider';
import { useI18n } from '../i18n';

/**
 * Scanning with the camera (FR-ING-06, -08, -09, -10), all on one screen. The phone's camera takes a picture, the page is found in it and
 * its corners can be moved (a sheet over this screen, so nothing is left), and the page is straightened and cleaned up, all on this
 * device: the only thing that leaves it is the finished set of pages (and the photos as taken, kept as the originals), sent like any
 * upload. The pages stay in front of the person as they are added: put in order, corrected, filtered or removed in place, then saved as
 * one document. Photos chosen on the upload screen arrive here the same way (`location.state.files`); how the pages group into
 * documents is the grouping screen's, after they are read.
 */
interface Page {
  id: number;
  raw: Blob;
  versions: Record<PageFilter, Blob>;
  previewUrl: string;
  filter: PageFilter;
  quad: Quad;
}

export default function Scan() {
  const { t, tn } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const chat = useChat();
  // Set when the photos were attached in the chat: the report of reading them comes back to that conversation.
  const fromChat = useRef<{ conversationId: string | null } | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [still, setStill] = useState<{ raw: Blob; url: string; loaded: Loaded; quad: Quad; replaces: number | null } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [canRead, setCanRead] = useState<boolean | null>(null);
  const next = useRef(1);

  // Pages with no text can only be read by a model (if the operator allows it) or by local OCR; without either, scanning would only fill the archive with pictures nobody can search.
  useEffect(() => {
    api.sourceFiles.capabilities()
      .then(c => setCanRead(c.aiReading.enabled || c.reading.mode === 'ocr' || (c.reading.mode === 'hybrid' && c.reading.ocr)))
      .catch(() => setCanRead(true));
  }, []);

  /** The picture opened, with the page found in it (or the whole photo, when none was). */
  const prepare = async (raw: Blob, quadHint?: Quad) => {
    const loaded = await loadRaster(raw);
    const quad = quadHint ?? (await detectDocument(loaded.raster).catch(() => null)) ?? defaultQuad(loaded.width, loaded.height);
    return { loaded, quad };
  };

  /** One picture: the corners are shown to be moved before it becomes a page. */
  const open = useCallback(async (raw: Blob, quadHint?: Quad, replaces: number | null = null) => {
    setBusy(t('Looking for the page…')); setError('');
    try {
      const { loaded, quad } = await prepare(raw, quadHint);
      setStill({ raw, url: URL.createObjectURL(raw), loaded, quad, replaces });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not open the picture.'));
    } finally {
      setBusy('');
    }
  }, [t]);

  const makePage = async (raw: Blob, loaded: Loaded, quad: Quad, id: number): Promise<Page> => {
    const versions = await processPage(loaded, quad);
    return { id, raw, versions, previewUrl: URL.createObjectURL(versions.clean), filter: 'clean', quad };
  };

  /** Several pictures at once: each is added with the page found in it, and the corners are there to move afterwards. */
  const addAll = useCallback(async (files: Blob[]) => {
    setError('');
    let failed = 0;
    for (const [i, raw] of files.entries()) {
      setBusy(t('Straightening page {n} of {total}…', { n: i + 1, total: files.length }));
      try {
        const { loaded, quad } = await prepare(raw);
        const page = await makePage(raw, loaded, quad, next.current++);
        setPages(list => [...list, page]);
      } catch {
        failed += 1;
      }
    }
    setBusy('');
    if (failed > 0) setError(tn(failed, '{n} picture could not be opened.', '{n} pictures could not be opened.'));
  }, [t, tn]);

  const take = useCallback((files: Blob[]) => { if (files.length === 1) void open(files[0]); else if (files.length > 1) void addAll(files); }, [open, addAll]);

  // Photos chosen on the upload screen.
  const handedOver = useRef(false);
  useEffect(() => {
    const handed = location.state as { files?: File[]; conversationId?: string | null; fromChat?: boolean } | null;
    const files = handed?.files;
    if (!files?.length || handedOver.current) return;
    handedOver.current = true;
    if (handed?.fromChat) fromChat.current = { conversationId: handed.conversationId ?? null };
    navigate(location.pathname, { replace: true, state: null });
    take(files);
  }, [location.state, location.pathname, navigate, take]);

  const accept = async () => {
    if (!still) return;
    setBusy(t('Straightening the page…')); setError('');
    try {
      const old = still.replaces !== null ? pages.find(p => p.id === still.replaces) : undefined;
      const made = await makePage(still.raw, still.loaded, still.quad, still.replaces ?? next.current++);
      // A page whose corners were redone keeps the filter chosen for it; the picture it was shown by is let go once the new one is on screen.
      const page = old && old.filter !== made.filter ? { ...made, filter: old.filter, previewUrl: URL.createObjectURL(made.versions[old.filter]) } : made;
      if (page !== made) URL.revokeObjectURL(made.previewUrl);
      setPages(list => (old ? list.map(p => (p.id === page.id ? page : p)) : [...list, page]));
      if (old) window.setTimeout(() => URL.revokeObjectURL(old.previewUrl), 1000);
      URL.revokeObjectURL(still.url);
      setStill(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not straighten the page. Move the corners onto the page and try again.'));
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    setBusy(t('Saving…')); setError('');
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const sheets = pages.map((p, i) => new File([p.versions[p.filter]], `scan ${stamp} p${i + 1}.jpg`, { type: 'image/jpeg' }));
      const originals = pages.map((p, i) => new File([p.raw], `scan ${stamp} original ${i + 1}.jpg`, { type: p.raw.type || 'image/jpeg' }));
      const tooPlain = t('Pages with no text can only be read here if image reading or local OCR is switched on.');
      let conversation: string | null = null;
      if (fromChat.current) {
        const made = await api.chat.attach(sheets, fromChat.current.conversationId, { originals });
        const first = made.files[0];
        if (!first?.upload_id) throw new Error(first?.reason === 'photo_needs_ai' ? tooPlain : t('The pages were not added.'));
        conversation = made.conversation.id;
      } else {
        const r = (await api.sourceFiles.uploadScan(sheets, originals))[0] as { id?: string; reason?: string } | undefined;
        if (!r?.id) throw new Error(r?.reason === 'photo_needs_ai' ? tooPlain : t('The pages were not added.'));
      }
      pages.forEach(p => URL.revokeObjectURL(p.previewUrl));
      navigate('/upload');
      if (conversation && chat) { await chat.openConversation(conversation); chat.setOpen(true); }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('The pages were not added.'));
      setBusy('');
    }
  };

  const move = (index: number, by: -1 | 1) => setPages(list => {
    const to = index + by;
    if (to < 0 || to >= list.length) return list;
    const copy = [...list]; [copy[index], copy[to]] = [copy[to], copy[index]];
    return copy;
  });
  // The preview follows the filter, so what is shown is what is saved.
  const setFilter = (id: number, filter: PageFilter) => setPages(list => list.map(p => {
    if (p.id !== id) return p;
    URL.revokeObjectURL(p.previewUrl);
    return { ...p, filter, previewUrl: URL.createObjectURL(p.versions[filter]) };
  }));

  const remove = (id: number) => setPages(list => { const gone = list.find(p => p.id === id); if (gone) URL.revokeObjectURL(gone.previewUrl); return list.filter(p => p.id !== id); });

  if (canRead === false) {
    return (
      <div className="max-w-md mx-auto">
        <h1 className="text-[1.75rem] leading-tight font-light tracking-tight text-gray-900 mb-2">{t('Scan')}</h1>
        <p className="text-sm text-gray-600">{t('Pages from a camera have no text, so they can only be read here if image reading or local OCR is switched on for this server. A scanning app that saves a PDF works without either.')}</p>
        <Link to="/upload" className="text-sm text-brand-600 hover:underline mt-3 inline-block">{t('Back to upload')}</Link>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-[1.75rem] leading-tight font-light tracking-tight text-gray-900">{t('Scan')}</h1>
        {pages.length > 0 && (
          <button type="button" onClick={save} disabled={!!busy} className="rounded-full bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">{tn(pages.length, 'Save {n} page as one document', 'Save {n} pages as one document')}</button>
        )}
      </div>
      {error && <p className="text-sm text-red-600 mb-3" role="alert">{error}</p>}
      {busy && <p className="text-sm text-gray-500 mb-3" role="status">{busy}</p>}

      {pages.length === 0 ? (
        <div>
          <AddPage big onTake={take} />
          <p className="mt-4 text-xs text-gray-500">{t('Lay the page flat on a darker surface. You will set its corners next.')}</p>
        </div>
      ) : (
        <>
          <ol className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {pages.map((p, i) => (
              <li key={p.id} className="bg-white border border-gray-200 rounded-xl p-2">
                <img src={p.previewUrl} alt={t('Page {n}', { n: i + 1 })} className="w-full h-auto rounded border border-gray-100" />
                <p className="text-xs text-gray-500 text-center mt-1">{i + 1}</p>
                <div className="flex justify-center gap-3 text-xs mt-1">
                  <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('Move page {n} earlier', { n: i + 1 })} className="text-gray-500 hover:text-gray-800 disabled:opacity-30">←</button>
                  <button type="button" disabled={i === pages.length - 1} onClick={() => move(i, 1)} aria-label={t('Move page {n} later', { n: i + 1 })} className="text-gray-500 hover:text-gray-800 disabled:opacity-30">→</button>
                  <button type="button" onClick={() => void open(p.raw, p.quad, p.id)} className="text-brand-600 hover:underline">{t('Corners')}</button>
                  <button type="button" onClick={() => remove(p.id)} className="text-gray-500 hover:text-red-600">{t('Remove')}</button>
                </div>
                <label className="flex items-center justify-center gap-1 text-xs text-gray-600 mt-1 min-w-0">
                  {t('Filter')}
                  <select value={p.filter} onChange={e => setFilter(p.id, e.target.value as PageFilter)} className="min-w-0 flex-1 border border-gray-300 rounded px-1 py-0.5 text-xs">
                    <option value="original">{t('Original')}</option>
                    <option value="clean">{t('Clean')}</option>
                    <option value="grey">{t('Greyscale')}</option>
                    <option value="bw">{t('Black and white')}</option>
                  </select>
                </label>
              </li>
            ))}
            <li className="flex min-h-40 flex-col justify-center rounded-xl border-2 border-dashed border-gray-300 bg-white p-2"><AddPage onTake={take} /></li>
          </ol>
          <p className="text-xs text-gray-500 mt-4">{t('The pages are straightened and cleaned up on this device. The photos as you took them are kept beside the document.')}</p>
        </>
      )}

      {still && (
        <div role="dialog" aria-modal="true" aria-label={t('Corners')} className="fixed inset-0 z-40 overflow-y-auto bg-gray-50 px-4 py-6">
          <div className="mx-auto max-w-3xl">
            <p className="text-sm text-gray-600 mb-2">{t('Drag each dot onto a corner of the page.')}</p>
            <CornerEditor src={still.url} width={still.loaded.width} height={still.loaded.height} quad={still.quad} onChange={quad => setStill(s => (s ? { ...s, quad } : s))} />
            <div className="flex flex-wrap items-center gap-3 mt-3 text-sm">
              <button type="button" onClick={accept} disabled={!!busy} className="bg-brand-600 text-white rounded-full px-4 py-2 font-medium hover:bg-brand-700 disabled:opacity-50">{t('Use this page')}</button>
              <button type="button" onClick={() => setStill(s => (s ? { ...s, quad: defaultQuad(s.loaded.width, s.loaded.height, 0) } : s))} className="text-gray-600 hover:underline">{t('Use the whole photo')}</button>
              <button type="button" onClick={() => { URL.revokeObjectURL(still.url); setStill(null); }} className="text-gray-600 hover:underline">{still.replaces !== null ? t('Keep the page as it was') : t('Retake')}</button>
            </div>
            {busy && <p className="text-sm text-gray-500 mt-3" role="status">{busy}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** The phone's own camera, or photos from the library (several at once). There is no live picture: nothing moves while the photo is taken. */
function AddPage({ big, onTake }: { big?: boolean; onTake: (files: Blob[]) => void }) {
  const { t } = useI18n();
  const picked = (e: React.ChangeEvent<HTMLInputElement>) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) onTake(files); };
  return (
    <div className="text-center">
      <label className={`block cursor-pointer rounded-full bg-brand-600 text-center font-medium text-white hover:bg-brand-700 ${big ? 'px-5 py-3 text-base' : 'px-3 py-2 text-sm'}`}>
        {big ? t('Take the picture') : t('Add a page')}
        <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={picked} />
      </label>
      <label className="mt-3 block cursor-pointer text-sm text-brand-600 hover:underline">
        {t('or choose photos')}
        <input type="file" accept="image/*" multiple className="sr-only" onChange={picked} />
      </label>
    </div>
  );
}
