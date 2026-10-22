import { useRef, useEffect, useState } from 'react';
import type { Page } from '../api';
import { useI18n } from '../i18n';

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
  page: Page;
  /** The page's place in its document, for the description; the file's own number if not given. */
  number?: number;
  /** Anything read off the page with a box on it: a field or a measurement. */
  highlightField: Highlight | null;
}

export default function PageImageOverlay({ page, number, highlightField }: Props) {
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

  // A page a model read has its text and no positions: the model's estimate of where text sat was
  // unreliable, so nothing is drawn on it, even for a page read before that was decided.
  const readByAi = page.extraction_source === 'multimodal';

  const showHighlight =
    highlightField &&
    highlightField.page_id === page.id &&
    highlightField.bbox_x0 !== null &&
    !readByAi &&
    imgSize;

  return (
    <div ref={containerRef} className="relative inline-block w-full">
      <img
        src={`/api/pages/${page.id}/image?r=${page.rotation ?? 0}`}
        alt={t('Page {n}', { n: number ?? page.page_number })}
        className="w-full rounded border border-gray-200 shadow-sm"
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
  );
}
