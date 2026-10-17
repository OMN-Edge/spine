import { Link } from 'react-router-dom';
import type { TrendPoint } from '../api';
import { useI18n } from '../i18n';

/**
 * A value over time, drawn as SVG: a line through the points, the printed reference range as a
 * shaded band, and each point coloured by whether it was low, high or in range. No chart library:
 * this is one shape, and a Pi should not load a dependency for it.
 *
 * The same points are in a table beside it (the caller's job), so the chart is never the only way
 * to read them. Each point links to the document it came from.
 */

const W = 640;
const H = 260;
const PAD = { left: 52, right: 16, top: 26, bottom: 34 };

/** A step that gives a few round tick values across a span: 1, 2, 5 times a power of ten. */
function niceStep(span: number, targetTicks: number): number {
  const rough = span / targetTicks;
  const power = 10 ** Math.floor(Math.log10(rough));
  const unit = rough / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

const colour = (flag: string | null) => (flag === 'high' ? '#dc2626' : flag === 'low' ? '#d97706' : '#2563eb');

// A value known only to its month ("2026-03") sits at the start of that month.
const day = (iso: string) => Date.parse(`${iso.length === 7 ? `${iso}-01` : iso}T00:00:00Z`);
const format = (n: number) => String(Number(n.toFixed(3)));

export default function TrendChart({ points, unit, documentHref = id => `/documents/${id}` }: { points: TrendPoint[]; unit: string | null; documentHref?: (documentId: string) => string }) {
  const { t: tr } = useI18n();
  const drawn = points.filter(p => p.charted && p.value_num !== null && p.taken_on);
  if (drawn.length === 0) return null;

  const xs = drawn.map(p => day(p.taken_on!));
  const ys = drawn.map(p => p.value_num!);

  // The range of the newest value: what a reader compares against today.
  const latest = drawn[drawn.length - 1];
  const low = latest.ref_low;
  const high = latest.ref_high;

  const yValues = [...ys, ...(low !== null ? [low] : []), ...(high !== null ? [high] : [])];
  let yMin = Math.min(...yValues);
  let yMax = Math.max(...yValues);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const step = niceStep(yMax - yMin, 4);
  const pad = (yMax - yMin) * 0.12;
  yMin = Math.floor((yMin - pad) / step) * step;
  yMax = Math.ceil((yMax + pad) / step) * step;

  let xMin = Math.min(...xs);
  let xMax = Math.max(...xs);
  if (xMin === xMax) { xMin -= 15 * 86_400_000; xMax += 15 * 86_400_000; } // one point sits in the middle

  const px = (x: number) => PAD.left + ((x - xMin) / (xMax - xMin)) * (W - PAD.left - PAD.right);
  const py = (y: number) => PAD.top + (1 - (y - yMin) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

  const ticks: number[] = [];
  for (let t = Math.ceil(yMin / step) * step; t <= yMax + step / 1e6; t += step) ticks.push(Number(t.toFixed(10)));

  const line = drawn.map(p => `${px(day(p.taken_on!)).toFixed(1)},${py(p.value_num!).toFixed(1)}`).join(' ');
  const first = drawn[0].taken_on!;
  const last = latest.taken_on!;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={tr('{n} values from {from} to {to}{unit}. A table of the values follows.', { n: drawn.length, from: first, to: last, unit: unit ? `, ${tr('in {unit}', { unit })}` : '' })}>
      {low !== null || high !== null ? (
        <rect
          x={PAD.left} width={W - PAD.left - PAD.right}
          y={py(high ?? yMax)} height={Math.max(0, py(low ?? yMin) - py(high ?? yMax))}
          fill="#dcfce7" opacity={0.7}
        >
          <title>{tr('Reference range {low} to {high}{unit}', { low: low !== null ? format(low) : '…', high: high !== null ? format(high) : '…', unit: unit ? ` ${unit}` : '' })}</title>
        </rect>
      ) : null}

      {ticks.map(t => (
        <g key={t}>
          <line x1={PAD.left} x2={W - PAD.right} y1={py(t)} y2={py(t)} stroke="#e5e7eb" strokeWidth={1} />
          <text x={PAD.left - 8} y={py(t) + 4} textAnchor="end" fontSize={11} fill="#6b7280">{format(t)}</text>
        </g>
      ))}
      {unit && <text x={PAD.left - 44} y={12} fontSize={11} fill="#9ca3af">{unit}</text>}

      <text x={PAD.left} y={H - 10} fontSize={11} fill="#6b7280">{first}</text>
      {first !== last && <text x={W - PAD.right} y={H - 10} textAnchor="end" fontSize={11} fill="#6b7280">{last}</text>}

      {drawn.length > 1 && <polyline points={line} fill="none" stroke="#93c5fd" strokeWidth={2} strokeLinejoin="round" />}

      {drawn.map(p => (
        <Link key={p.id} to={documentHref(p.document_id)}>
          <circle cx={px(day(p.taken_on!))} cy={py(p.value_num!)} r={5.5} fill={colour(p.flag)} stroke="#fff" strokeWidth={2}>
            <title>{`${p.value_text}${p.unit ? ` ${p.unit}` : ''} · ${p.taken_on}${p.taken_on!.length === 7 ? ` (${tr('month only')})` : ''}${p.document_title ? ` · ${p.document_title}` : ''}`}</title>
          </circle>
        </Link>
      ))}
    </svg>
  );
}
