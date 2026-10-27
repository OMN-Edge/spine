import { useId } from 'react';
import type { ReactNode } from 'react';

/**
 * The upload log, drawn as a spine seen from the front. Each upload is a small vertebral
 * body beside its row, waisted at the middle and widening slightly down the column; an
 * intervertebral disc sits in the gap between rows, and a dotted axis runs through all of
 * them. Used for the upload log, where a body fills from the bottom as its file is
 * processed, and for the timeline, where it shows whether a document has been reviewed:
 *
 *   working     outline, filling with progress
 *   done        solid (processed, or reviewed)
 *   unreviewed  amber outline, empty
 *   error       red
 *   duplicate   dashed and empty (nothing was added)
 *
 * `loose` draws the vertebrae without the axis and discs, each slightly tilted and
 * offset: bones not yet added to the spine. Used where a list is not a sequence in time —
 * the review queue (documents waiting to join the archive) and search results (pulled out
 * of it, in no particular order).
 *
 * It is decoration around real text: every state is also in the row beside it. Where
 * there is progress it is exposed as a `progressbar`; otherwise the column is hidden from
 * assistive technology, so nothing depends on seeing the picture.
 */

export type VertebraState = 'working' | 'done' | 'unreviewed' | 'error' | 'duplicate';

export interface SpineLogItem {
  id: string;
  state: VertebraState;
  /** 0 to 100. Omitted where nothing is in progress, as on the timeline. */
  progress?: number;
  /** The progressbar's accessible name, when there is progress. */
  label?: string;
  children: ReactNode;
}

const COLUMN = 40; // width of the spine column, in px
const BODY_HEIGHT = 22;
const GAP = 12; // between rows; the disc sits in it
const DISC_HEIGHT = 6;
const AXIS = COLUMN / 2;

const TONE = {
  working: { line: '#0f766e', fill: '#0f766e' },
  done: { line: '#0f766e', fill: '#0f766e' },
  unreviewed: { line: '#d97706', fill: '#d97706' },
  error: { line: '#dc2626', fill: '#fca5a5' },
  duplicate: { line: '#a3a099', fill: '#a3a099' },
} as const;

/** Slightly wider down the column, as real vertebrae are. */
const bodyWidth = (index: number) => 24 + Math.min(index, 6);

// Loose vertebrae: varied rather than growing (there is no column to grow down), and each
// set down at a small fixed angle and offset. Fixed per position, so nothing jumps on a
// re-render.
const LOOSE_WIDTH = [26, 24, 28, 25, 27, 24, 26];
const LOOSE_TILT = [-8, 5, -3, 7, -6, 3, -4];
const LOOSE_SHIFT = [-3, 2, 0, 3, -2, 1, -1];
const pick = (list: number[], index: number) => list[index % list.length];

/** A vertebral body: a rounded block whose sides curve in at the middle. */
function bodyPath(x0: number, y0: number, w: number, h: number, r: number, waist: number) {
  const x1 = x0 + w;
  const y1 = y0 + h;
  return [
    `M${x0 + r} ${y0}H${x1 - r}Q${x1} ${y0} ${x1} ${y0 + r}`,
    `C${x1 - waist} ${y0 + h * 0.35} ${x1 - waist} ${y0 + h * 0.65} ${x1} ${y1 - r}`,
    `Q${x1} ${y1} ${x1 - r} ${y1}H${x0 + r}Q${x0} ${y1} ${x0} ${y1 - r}`,
    `C${x0 + waist} ${y0 + h * 0.65} ${x0 + waist} ${y0 + h * 0.35} ${x0} ${y0 + r}`,
    `Q${x0} ${y0} ${x0 + r} ${y0}Z`,
  ].join('');
}

function Vertebra({ item, index, loose }: { item: SpineLogItem; index: number; loose: boolean }) {
  const clip = `vert-${useId().replace(/:/g, '')}`;
  const width = loose ? pick(LOOSE_WIDTH, index) : bodyWidth(index);
  const height = BODY_HEIGHT + 2; // room for the stroke
  const d = bodyPath(AXIS - width / 2, 1, width, BODY_HEIGHT, 5, width * 0.09);
  const tone = TONE[item.state];
  const dash = item.state === 'duplicate' ? '3 2' : undefined;
  const filled = item.state === 'done' ? 100
    : item.state === 'duplicate' || item.state === 'unreviewed' ? 0
    : item.progress ?? 0;
  const fillHeight = (BODY_HEIGHT * Math.max(0, Math.min(100, filled))) / 100;

  return (
    <svg
      width={COLUMN} height={height} viewBox={`0 0 ${COLUMN} ${height}`} className="block" aria-hidden="true" focusable="false"
      style={loose ? { transform: `translateX(${pick(LOOSE_SHIFT, index)}px) rotate(${pick(LOOSE_TILT, index)}deg)` } : undefined}
    >
      <defs>
        <clipPath id={clip}>
          <path d={d} />
        </clipPath>
      </defs>
      <path d={d} fill="#ffffff" />
      <rect
        x={0} y={1 + BODY_HEIGHT - fillHeight} width={COLUMN} height={fillHeight}
        fill={tone.fill} clipPath={`url(#${clip})`}
        className="transition-all duration-500 motion-reduce:transition-none"
      />
      <path d={d} fill="none" stroke={tone.line} strokeWidth={1.5} strokeDasharray={dash} />
    </svg>
  );
}

export default function SpineLog({ items, loose = false }: { items: SpineLogItem[]; loose?: boolean }) {
  return (
    <ol className="flex flex-col" style={{ gap: GAP }}>
      {items.map((item, index) => {
        const first = index === 0;
        const last = index === items.length - 1;
        const discWidth = ((bodyWidth(index) + bodyWidth(index + 1)) / 2) * 0.85;
        return (
          <li key={item.id} className="relative flex items-center gap-3">
            {/* the axis: from this row's centre (or the gap above) to the gap below (or the centre) */}
            {!loose && items.length > 1 && (
              <span
                aria-hidden="true"
                className="absolute border-l-2 border-dotted border-brand-300"
                style={{
                  left: AXIS - 1,
                  top: first ? '50%' : -GAP / 2,
                  bottom: last ? '50%' : -GAP / 2,
                }}
              />
            )}
            {/* the disc, centred in the gap between this row and the next */}
            {!loose && !last && (
              <span
                aria-hidden="true"
                className="absolute rounded-full bg-brand-200"
                style={{
                  left: AXIS - discWidth / 2,
                  width: discWidth,
                  height: DISC_HEIGHT,
                  bottom: -(GAP + DISC_HEIGHT) / 2,
                }}
              />
            )}
            <div
              {...(item.progress === undefined
                ? { 'aria-hidden': true }
                : {
                    role: 'progressbar',
                    'aria-label': item.label,
                    'aria-valuemin': 0,
                    'aria-valuemax': 100,
                    'aria-valuenow': item.state === 'done' ? 100 : item.progress,
                  })}
              className="relative shrink-0"
              style={{ width: COLUMN }}
            >
              <Vertebra item={item} index={index} loose={loose} />
            </div>
            <div className="min-w-0 flex-1">{item.children}</div>
          </li>
        );
      })}
    </ol>
  );
}
