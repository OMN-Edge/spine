import { useRef, useEffect, useState } from 'react';
import type { Page } from '../api';

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
  /** Anything read off the page with a box on it: a field or a measurement. */
  highlightField: Highlight | null;
}

export default function PageImageOverlay({ page, highlightField }: Props) {
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

  // A model reports where it read each block, and gets it roughly right. Draw that
  // as a dashed box and say so, rather than implying the sidecar's exact positions.
  const approximate = page.extraction_source === 'multimodal';

  const showHighlight =
    highlightField &&
    highlightField.page_id === page.id &&
    highlightField.bbox_x0 !== null &&
    imgSize;

  return (
    <div ref={containerRef} className="relative inline-block w-full">
      <img
        src={`/api/pages/${page.id}/image`}
        alt={`Page ${page.page_number}`}
        className="w-full rounded border border-gray-200 shadow-sm"
        draggable={false}
      />

      {showHighlight && (
        <div
          className={`absolute pointer-events-none border-2 border-yellow-400 bg-yellow-100/30 rounded ${
            approximate ? 'border-dashed' : ''
          }`}
          style={{
            left: `${highlightField.bbox_x0! * imgSize.w}px`,
            top: `${highlightField.bbox_y0! * imgSize.h}px`,
            width: `${(highlightField.bbox_x1! - highlightField.bbox_x0!) * imgSize.w}px`,
            height: `${(highlightField.bbox_y1! - highlightField.bbox_y0!) * imgSize.h}px`,
          }}
        />
      )}

      {approximate && (
        <span
          className="absolute top-2 right-2 text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full"
          title="This page was read by an AI model. The highlighted position is its estimate."
        >
          Read by AI · position approximate
        </span>
      )}

      {page.extraction_source === 'ocr' && (
        <span className="absolute top-2 right-2 text-xs bg-orange-100 text-orange-600 px-2 py-0.5 rounded-full">
          OCR
        </span>
      )}
    </div>
  );
}
