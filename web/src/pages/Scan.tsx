import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import CornerEditor from '../scan/CornerEditor';
import { defaultQuad, detectDocument, steady } from '../scan/detect';
import type { Quad } from '../scan/image';
import { loadRaster, processPage, type Loaded } from '../scan/process';
import { useI18n } from '../i18n';

/**
 * Scanning with the camera (FR-ING-06, -08, -09, -10). The page is found in the live picture, the camera takes it when the page has
 * been still for a moment, the corners can be moved, and the page is straightened and cleaned up, all on this device: the only thing
 * that leaves it is the finished set of pages (and the photos as taken, kept as the originals), sent like any upload. Pages are
 * taken one after another, then reviewed, put in order and saved as one document.
 */
interface Page {
  id: number;
  raw: Blob;
  plain: Blob;
  clean: Blob;
  previewUrl: string;
  cleanUp: boolean;
  quad: Quad;
}

const STEADY_MS = 900;
const TICK_MS = 250;
const COOLDOWN_MS = 2500;

export default function Scan() {
  const { t, tn } = useI18n();
  const navigate = useNavigate();
  const [pages, setPages] = useState<Page[]>([]);
  const [mode, setMode] = useState<'camera' | 'adjust' | 'review'>('camera');
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

  const open = useCallback(async (raw: Blob, quadHint?: Quad, replaces: number | null = null) => {
    setBusy(t('Looking for the page…')); setError('');
    try {
      const loaded = await loadRaster(raw);
      const found = quadHint ?? detectDocument(loaded.raster) ?? defaultQuad(loaded.width, loaded.height);
      setStill({ raw, url: URL.createObjectURL(raw), loaded, quad: found, replaces });
      setMode('adjust');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not open the picture.'));
    } finally {
      setBusy('');
    }
  }, [t]);

  const accept = async () => {
    if (!still) return;
    setBusy(t('Straightening the page…')); setError('');
    try {
      const { plain, clean } = await processPage(still.loaded, still.quad);
      const page: Page = { id: still.replaces ?? next.current++, raw: still.raw, plain, clean, previewUrl: URL.createObjectURL(clean), cleanUp: true, quad: still.quad };
      setPages(list => (still.replaces !== null ? list.map(p => (p.id === still.replaces ? page : p)) : [...list, page]));
      URL.revokeObjectURL(still.url);
      setStill(null);
      setMode(still.replaces !== null ? 'review' : 'camera');
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
      const results = await api.sourceFiles.uploadScan(
        pages.map((p, i) => new File([p.cleanUp ? p.clean : p.plain], `scan ${stamp} p${i + 1}.jpg`, { type: 'image/jpeg' })),
        pages.map((p, i) => new File([p.raw], `scan ${stamp} original ${i + 1}.jpg`, { type: p.raw.type || 'image/jpeg' })),
      );
      const r = results[0] as { id?: string; reason?: string };
      if (!r?.id) throw new Error(r?.reason === 'photo_needs_ai' ? t('Pages with no text can only be read here if image reading or local OCR is switched on.') : t('The pages were not added.'));
      pages.forEach(p => URL.revokeObjectURL(p.previewUrl));
      navigate('/upload');
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
  const remove = (id: number) => setPages(list => { const gone = list.find(p => p.id === id); if (gone) URL.revokeObjectURL(gone.previewUrl); return list.filter(p => p.id !== id); });

  if (canRead === false) {
    return (
      <div className="max-w-md mx-auto">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">{t('Scan')}</h1>
        <p className="text-sm text-gray-600">{t('Pages from a camera have no text, so they can only be read here if image reading or local OCR is switched on for this server. A scanning app that saves a PDF works without either.')}</p>
        <Link to="/upload" className="text-sm text-blue-600 hover:underline mt-3 inline-block">{t('Back to upload')}</Link>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold text-gray-900">{t('Scan')}</h1>
        {pages.length > 0 && mode !== 'review' && (
          <button type="button" onClick={() => setMode('review')} className="text-sm text-blue-600 hover:underline">{tn(pages.length, 'Review {n} page', 'Review {n} pages')}</button>
        )}
      </div>
      {error && <p className="text-sm text-red-600 mb-3" role="alert">{error}</p>}
      {busy && <p className="text-sm text-gray-500 mb-3" role="status">{busy}</p>}

      {mode === 'camera' && <CameraStep count={pages.length} onShot={raw => void open(raw)} />}

      {mode === 'adjust' && still && (
        <div>
          <p className="text-sm text-gray-600 mb-2">{t('Drag each blue dot onto a corner of the page.')}</p>
          <CornerEditor src={still.url} width={still.loaded.width} height={still.loaded.height} quad={still.quad} onChange={quad => setStill(s => (s ? { ...s, quad } : s))} />
          <div className="flex flex-wrap gap-3 mt-3 text-sm">
            <button type="button" onClick={accept} disabled={!!busy} className="bg-blue-600 text-white rounded-lg px-4 py-2 font-medium hover:bg-blue-700 disabled:opacity-50">{t('Use this page')}</button>
            <button type="button" onClick={() => setStill(s => (s ? { ...s, quad: defaultQuad(s.loaded.width, s.loaded.height, 0) } : s))} className="text-gray-600 hover:underline">{t('Use the whole photo')}</button>
            <button type="button" onClick={() => { URL.revokeObjectURL(still.url); const back = still.replaces !== null; setStill(null); setMode(back ? 'review' : 'camera'); }} className="text-gray-600 hover:underline">{back(still.replaces, t)}</button>
          </div>
        </div>
      )}

      {mode === 'review' && (
        <div>
          {pages.length === 0 ? (
            <p className="text-sm text-gray-500">{t('No pages yet.')}</p>
          ) : (
            <ol className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {pages.map((p, i) => (
                <li key={p.id} className="bg-white border border-gray-200 rounded-xl p-2">
                  <img src={p.previewUrl} alt={t('Page {n}', { n: i + 1 })} className="w-full h-auto rounded border border-gray-100" />
                  <p className="text-xs text-gray-500 text-center mt-1">{i + 1}</p>
                  <div className="flex justify-center gap-3 text-xs mt-1">
                    <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('Move page {n} earlier', { n: i + 1 })} className="text-gray-500 hover:text-gray-800 disabled:opacity-30">←</button>
                    <button type="button" disabled={i === pages.length - 1} onClick={() => move(i, 1)} aria-label={t('Move page {n} later', { n: i + 1 })} className="text-gray-500 hover:text-gray-800 disabled:opacity-30">→</button>
                    <button type="button" onClick={() => void open(p.raw, p.quad, p.id)} className="text-blue-600 hover:underline">{t('Corners')}</button>
                    <button type="button" onClick={() => remove(p.id)} className="text-gray-500 hover:text-red-600">{t('Remove')}</button>
                  </div>
                  <label className="flex items-center justify-center gap-1 text-xs text-gray-600 mt-1">
                    <input type="checkbox" checked={p.cleanUp} onChange={e => setPages(list => list.map(q => (q.id === p.id ? { ...q, cleanUp: e.target.checked } : q)))} />
                    {t('Clean up shadows and fading')}
                  </label>
                </li>
              ))}
            </ol>
          )}
          <div className="flex flex-wrap gap-3 mt-4 text-sm">
            <button type="button" onClick={() => setMode('camera')} className="text-blue-600 hover:underline">{t('Add a page')}</button>
            <button type="button" onClick={save} disabled={pages.length === 0 || !!busy} className="bg-blue-600 text-white rounded-lg px-4 py-2 font-medium hover:bg-blue-700 disabled:opacity-50 ml-auto">{tn(pages.length, 'Save {n} page as one document', 'Save {n} pages as one document')}</button>
          </div>
          <p className="text-xs text-gray-500 mt-3">{t('The pages are straightened and cleaned up on this device. The photos as you took them are kept beside the document.')}</p>
        </div>
      )}
    </div>
  );
}

const back = (replaces: number | null, t: (s: string) => string) => (replaces !== null ? t('Keep the page as it was') : t('Retake'));

/** The live camera with the page outlined on it, and the shutter; or, where there is no camera to open, the phone's own camera or a file. */
function CameraStep({ count, onShot }: { count: number; onShot: (raw: Blob) => void }) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const work = useRef<HTMLCanvasElement | null>(null);
  const [live, setLive] = useState<'starting' | 'on' | 'off'>('starting');
  const [auto, setAuto] = useState(true);
  const last = useRef<{ quad: Quad | null; since: number; shot: number }>({ quad: null, since: 0, shot: 0 });
  const autoRef = useRef(true);

  const shoot = useCallback(() => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth; canvas.height = v.videoHeight;
    canvas.getContext('2d')?.drawImage(v, 0, 0);
    last.current.shot = Date.now();
    canvas.toBlob(b => { if (b) onShot(b); }, 'image/jpeg', 0.95);
  }, [onShot]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let gone = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setLive('off'); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        if (gone) { stream.getTracks().forEach(tr => tr.stop()); return; }
        if (video.current) { video.current.srcObject = stream; await video.current.play().catch(() => undefined); }
        setLive('on');
        timer = window.setInterval(() => {
          const v = video.current; const o = overlay.current;
          if (!v || !o || !v.videoWidth) return;
          const w = work.current ?? (work.current = document.createElement('canvas'));
          const scale = 320 / v.videoWidth;
          w.width = 320; w.height = Math.round(v.videoHeight * scale);
          const ctx = w.getContext('2d', { willReadFrequently: true });
          if (!ctx) return;
          ctx.drawImage(v, 0, 0, w.width, w.height);
          const frame = ctx.getImageData(0, 0, w.width, w.height);
          const quad = detectDocument({ data: frame.data, width: w.width, height: w.height });
          o.width = w.width; o.height = w.height;
          const octx = o.getContext('2d');
          octx?.clearRect(0, 0, o.width, o.height);
          if (quad && octx) {
            octx.strokeStyle = '#22c55e'; octx.lineWidth = 3; octx.fillStyle = 'rgba(34,197,94,0.15)';
            octx.beginPath(); quad.forEach((p, i) => (i === 0 ? octx.moveTo(p.x, p.y) : octx.lineTo(p.x, p.y))); octx.closePath(); octx.fill(); octx.stroke();
          }
          const now = Date.now();
          const state = last.current;
          if (steady(state.quad, quad, { width: w.width, height: w.height })) {
            if (now - state.since >= STEADY_MS && now - state.shot >= COOLDOWN_MS && autoRef.current) { state.since = now; shoot(); }
          } else {
            state.since = now;
          }
          state.quad = quad;
        }, TICK_MS);
      } catch {
        setLive('off');
      }
    })();
    return () => { gone = true; window.clearInterval(timer); stream?.getTracks().forEach(tr => tr.stop()); };
  }, [shoot]);

  useEffect(() => { autoRef.current = auto; }, [auto]);

  const picked = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onShot(f); };

  return (
    <div>
      <div className={`relative bg-black rounded-xl overflow-hidden ${live === 'on' ? '' : 'hidden'}`}>
        <video ref={video} playsInline muted className="w-full h-auto block" />
        <canvas ref={overlay} className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true" />
      </div>
      {live === 'starting' && <p className="text-sm text-gray-500">{t('Opening the camera…')}</p>}
      {live === 'off' && <p className="text-sm text-gray-600 mb-3">{t('The camera could not be opened here. Take the picture with your phone’s camera, or choose a photo.')}</p>}
      <div className="flex flex-wrap items-center gap-3 mt-3 text-sm">
        {live === 'on' && <button type="button" onClick={shoot} className="bg-blue-600 text-white rounded-full px-5 py-2 font-medium hover:bg-blue-700">{t('Take the picture')}</button>}
        {live === 'on' && (
          <label className="flex items-center gap-1.5 text-gray-600">
            <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} /> {t('Take it when the page is still')}
          </label>
        )}
        <label className="text-blue-600 hover:underline cursor-pointer">
          {live === 'on' ? t('or choose a photo') : t('Take or choose a photo')}
          <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={picked} />
        </label>
      </div>
      <p className="text-xs text-gray-500 mt-3">{count === 0 ? t('Lay the page flat with a darker surface around it. The green outline is the page Spine found; it takes the picture when you hold still.') : t('Next page. Lay it flat and hold still.')}</p>
    </div>
  );
}
