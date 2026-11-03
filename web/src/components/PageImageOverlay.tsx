import { useRef, useEffect, useLayoutEffect, useState } from 'react';
import type { Page } from '../api';
import { useI18n } from '../i18n';
import DeviceImg from './DeviceImg';
import { clampZoom, scrollForAnchor, ZOOM_MAX, ZOOM_MIN, type ZoomAnchor } from '../page-zoom';

/** What the overlay needs to draw a box: the page it is on and where. */
export interface Highlight {
  id: string;
  page_id: string;
  bbox_x0: number | null;
  bbox_y0: number | null;
  bbox_x1: number | null;
  bbox_y1: number | null;
}

interface Props {
  page: Pick<Page, 'id' | 'page_number' | 'rotation' | 'extraction_source'>;
  /** Where the image is, when not the owner's own (a share's reader has its pages at the share's address). */
  src?: string;
  /** The page's place in its document, for the description; the file's own number if not given. */
  number?: number;
  /** Anything read off the page with a box on it: a field or a measurement. */
  highlightField: Highlight | null;
}

export default function PageImageOverlay({ page, src, number, highlightField }: Props) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const img = containerRef.current?.querySelector('img');
    if (!img) return;
    const update = () => setImgSize({ w: img.offsetWidth, h: img.offsetHeight });
    img.addEventListener('load', update);
    if (img.complete) update();
    const ro = new ResizeObserver(update);
    ro.observe(img);
    return () => { img.removeEventListener('load', update); ro.disconnect(); };
  }, [page.id]);

  // Zoom: the scan alone, never the page around it. Two fingers pinch and move it on a touch screen; a trackpad pinch, Ctrl with the
  // wheel or the buttons zoom it on a computer. Zoomed, the viewer scrolls the scan inside itself, in both directions, and is kept
  // within the screen's height; fitted, it is as tall as the scan and the page scrolls past it as before. The highlight follows,
  // since it is measured off the image.
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1); // the latest, for the gesture handlers
  const pending = useRef<ZoomAnchor | null>(null);

  /** Zooms to `next` with the anchor's spot of the scan at its place in the viewer (the viewer's middle when there is none). */
  const zoomRef = useRef((next: number, anchor?: ZoomAnchor) => {
    const el = viewportRef.current;
    if (!el) return;
    const target = anchor ?? { fx: (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth, fy: (el.scrollTop + el.clientHeight / 2) / el.scrollHeight, x: el.clientWidth / 2, y: el.clientHeight / 2 };
    const s = clampZoom(next);
    if (s === scaleRef.current) {
      const to = scrollForAnchor(target, el.scrollWidth, el.scrollHeight);
      el.scrollTo(to.left, to.top);
      return;
    }
    pending.current = target;
    scaleRef.current = s;
    setScale(s);
  });
  const zoom = zoomRef.current;

  useLayoutEffect(() => {
    const el = viewportRef.current;
    const anchor = pending.current;
    if (!el || !anchor) return;
    pending.current = null;
    const to = scrollForAnchor(anchor, el.scrollWidth, el.scrollHeight);
    el.scrollTo(to.left, to.top);
  }, [scale]);

  // Another page starts fitted.
  useEffect(() => { scaleRef.current = 1; setScale(1); }, [page.id]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const at = (clientX: number, clientY: number) => {
      const box = el.getBoundingClientRect();
      const x = clientX - box.left, y = clientY - box.top;
      return { fx: (el.scrollLeft + x) / el.scrollWidth, fy: (el.scrollTop + y) / el.scrollHeight, x, y };
    };
    const middle = (t: TouchList) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2] as const;
    const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    // A pinch keeps the spot first between the fingers between them, so moving both fingers moves the scan too.
    let pinch: { spread: number; scale: number; fx: number; fy: number } | null = null;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const spot = at(...middle(e.touches));
      pinch = { spread: spread(e.touches) || 1, scale: scaleRef.current, fx: spot.fx, fy: spot.fy };
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const { x, y } = at(...middle(e.touches));
      zoom(pinch.scale * spread(e.touches) / pinch.spread, { fx: pinch.fx, fy: pinch.fy, x, y });
    };
    const onTouchEnd = (e: TouchEvent) => { if (e.touches.length < 2) pinch = null; };
    // A trackpad pinch in Chrome and Firefox, and Ctrl with the wheel anywhere.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoom(scaleRef.current * Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) / 100), at(e.clientX, e.clientY));
    };
    // A trackpad pinch in Safari on a Mac comes as its own gesture events. On a phone the touches above have the pinch already.
    let gestureFrom = 1;
    const onGestureStart = (e: Event) => { e.preventDefault(); gestureFrom = scaleRef.current; };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      if (pinch) return;
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      zoom(gestureFrom * g.scale, at(g.clientX, g.clientY));
    };
    const opts = { passive: false };
    el.addEventListener('touchstart', onTouchStart, opts);
    el.addEventListener('touchmove', onTouchMove, opts);
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    el.addEventListener('wheel', onWheel, opts);
    el.addEventListener('gesturestart', onGestureStart, opts);
    el.addEventListener('gesturechange', onGestureChange, opts);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
    };
  }, [zoom]);

  // A page a model read has its text and no positions: the model's estimate of where text sat was
  // unreliable, so nothing is drawn on it, even for a page read before that was decided.
  const readByAi = page.extraction_source === 'multimodal';

  const showHighlight =
    highlightField &&
    highlightField.page_id === page.id &&
    highlightField.bbox_x0 !== null &&
    !readByAi &&
    imgSize;

  const button = 'h-8 min-w-8 px-2 flex items-center justify-center text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div className="relative">
      {/* Computers only (a mouse or trackpad): on a touch screen two fingers do it. */}
      <div role="group" aria-label={t('Zoom')} className="absolute top-2 right-2 z-10 hidden [@media(hover:hover)]:flex items-center rounded-lg border border-gray-200 bg-white/95 shadow-sm text-sm overflow-hidden">
        <button type="button" onClick={() => zoom(scale / 1.5)} disabled={scale <= ZOOM_MIN} aria-label={t('Zoom out')} title={t('Zoom out')} className={button}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
        </button>
        <button type="button" onClick={() => zoom(1)} disabled={scale === 1} aria-label={t('Fit to width')} title={t('Fit to width')} className={`${button} tabular-nums text-xs w-14`}>
          {Math.round(scale * 100)}%
        </button>
        <button type="button" onClick={() => zoom(scale * 1.5)} disabled={scale >= ZOOM_MAX} aria-label={t('Zoom in')} title={t('Zoom in')} className={button}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>

      <div
        ref={viewportRef}
        className={`overflow-auto touch-pan-x touch-pan-y rounded ${scale > 1 ? 'max-h-[80dvh] border border-gray-200' : ''}`}
      >
        <div ref={containerRef} className="relative" style={{ width: `${scale * 100}%` }}>
          <DeviceImg
            src={src ?? `/api/pages/${page.id}/image?r=${page.rotation ?? 0}`}
            alt={t('Page {n}', { n: number ?? page.page_number })}
            className={`w-full max-w-none rounded shadow-sm select-none ${scale > 1 ? '' : 'border border-gray-200'}`}
            draggable={false}
          />

          {showHighlight && (
            <div
              className="absolute pointer-events-none border-2 border-yellow-400 bg-yellow-100/30 rounded"
              style={{
                left: `${highlightField.bbox_x0! * imgSize.w}px`,
                top: `${highlightField.bbox_y0! * imgSize.h}px`,
                width: `${(highlightField.bbox_x1! - highlightField.bbox_x0!) * imgSize.w}px`,
                height: `${(highlightField.bbox_y1! - highlightField.bbox_y0!) * imgSize.h}px`,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
