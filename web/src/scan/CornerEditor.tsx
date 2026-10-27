import { useRef } from 'react';
import { useI18n } from '../i18n';
import type { Point, Quad } from './image';

/**
 * A photo with four handles on it, to put on the page's corners (FR-ING-06: manual adjustment). Dragged with a finger or a mouse;
 * an arrow key moves the focused handle a little, so it works without either. Corners are in the photo's own pixels.
 */
export default function CornerEditor({ src, width, height, quad, onChange }: { src: string; width: number; height: number; quad: Quad; onChange: (q: Quad) => void }) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const names = [t('top left'), t('top right'), t('bottom right'), t('bottom left')];

  const move = (i: number, p: Point) => {
    const next = quad.map((q, n) => (n === i ? { x: Math.min(width, Math.max(0, p.x)), y: Math.min(height, Math.max(0, p.y)) } : q)) as Quad;
    onChange(next);
  };
  const fromEvent = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * width, y: ((e.clientY - r.top) / r.height) * height };
  };

  return (
    <div ref={box} className="relative w-full select-none touch-none bg-black" style={{ aspectRatio: `${width} / ${height}` }}>
      <img src={src} alt={t('The photo')} className="absolute inset-0 w-full h-full object-contain pointer-events-none" draggable={false} />
      <svg viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true">
        <polygon points={quad.map(p => `${p.x},${p.y}`).join(' ')} fill="rgba(20,149,138,0.2)" stroke="#14958a" strokeWidth={Math.max(2, width / 300)} />
      </svg>
      {quad.map((p, i) => (
        <button
          key={i} type="button" aria-label={t('Corner: {name}', { name: names[i] })}
          style={{ left: `${(p.x / width) * 100}%`, top: `${(p.y / height) * 100}%` }}
          className="absolute -translate-x-1/2 -translate-y-1/2 h-9 w-9 rounded-full border-2 border-white bg-brand-600/80 shadow focus:outline-none focus:ring-2 focus:ring-brand-300"
          onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) move(i, fromEvent(e)); }}
          onKeyDown={e => {
            const step = Math.max(2, Math.round(width / 200));
            const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key as 'ArrowLeft'];
            if (d) { e.preventDefault(); move(i, { x: p.x + d[0], y: p.y + d[1] }); }
          }}
        />
      ))}
    </div>
  );
}
