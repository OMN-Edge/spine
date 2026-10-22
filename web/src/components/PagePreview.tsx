import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';

export interface PreviewPage {
  id: string;
  page_number: number;
  rotation?: number;
}

/**
 * A big look at one page of an upload, for checking where a document starts and ends. It
 * only shows: nothing here edits (that is the review screen's job). Left and right (keys or
 * the buttons) move through every page of the upload, not just one document's; Escape, the
 * close button or a click outside closes it. Tapping the page toggles between fitting the
 * screen and full width, scrolling to read small print.
 *
 * A native <dialog>, so the browser handles focus trapping, Escape and the backdrop.
 */
export default function PagePreview({
  pages,
  index,
  caption,
  extras,
  onIndex,
  onClose,
}: {
  pages: PreviewPage[];
  index: number;
  /** Anything to offer about the page being shown, under it (the preview itself only views). */
  extras?: (page: PreviewPage) => ReactNode;
  /** Where the page sits: which document it belongs to. */
  caption: (page: PreviewPage) => string;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [zoomed, setZoomed] = useState(false);
  const page = pages[index];

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);

  // A new page starts fitted to the screen.
  useEffect(() => setZoomed(false), [index]);

  // Warm the neighbours, so moving along the pages does not wait on each image.
  useEffect(() => {
    for (const neighbour of [pages[index - 1], pages[index + 1]]) {
      if (neighbour) new Image().src = `/api/pages/${neighbour.id}/image?r=${neighbour.rotation ?? 0}`;
    }
  }, [pages, index]);

  const go = (to: number) => { if (to >= 0 && to < pages.length) onIndex(to); };

  const button =
    'h-11 w-11 rounded-full bg-white/10 text-white hover:bg-white/20 focus:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10 flex items-center justify-center';

  return (
    <dialog
      ref={dialog}
      aria-label={t('Page {n} of {total}', { n: page.page_number, total: pages.length })}
      onClose={onClose}
      onClick={e => { if (e.target === dialog.current) onClose(); }}
      onKeyDown={e => {
        if (e.key === 'ArrowLeft') go(index - 1);
        if (e.key === 'ArrowRight') go(index + 1);
      }}
      className="m-0 p-0 w-screen h-screen max-w-none max-h-none bg-neutral-950 backdrop:bg-black"
    >
      <div className="h-full flex flex-col" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="flex items-center justify-between gap-3 px-4 py-3 text-white">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t('Page {n} of {total}', { n: page.page_number, total: pages.length })}</p>
            <p className="text-xs text-white/70 truncate">{caption(page)}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t('Close preview')} className={button}>
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div
          className={`flex-1 min-h-0 overflow-auto px-2 ${zoomed ? '' : 'flex items-center justify-center'}`}
          onClick={e => { if (e.target === e.currentTarget) onClose(); }}
        >
          <img
            key={page.id}
            src={`/api/pages/${page.id}/image?r=${page.rotation ?? 0}`}
            alt={t('Page {n}', { n: page.page_number })}
            onClick={() => setZoomed(z => !z)}
            className={`bg-white rounded shadow-lg select-none ${
              zoomed ? 'w-full max-w-none cursor-zoom-out mx-auto' : 'max-h-full max-w-full object-contain cursor-zoom-in'
            }`}
          />
        </div>

        {extras && <div className="px-4 pt-2 max-w-xl w-full self-center text-white">{extras(page)}</div>}

        <div className="flex items-center justify-center gap-4 px-4 py-3">
          <button type="button" onClick={() => go(index - 1)} disabled={index === 0} aria-label={t('Previous page')} className={button}>
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
          </button>
          <span className="text-xs text-white/70 w-24 text-center">{zoomed ? t('tap to fit') : t('tap to zoom')}</span>
          <button type="button" onClick={() => go(index + 1)} disabled={index === pages.length - 1} aria-label={t('Next page')} className={button}>
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
          </button>
        </div>
      </div>
    </dialog>
  );
}
