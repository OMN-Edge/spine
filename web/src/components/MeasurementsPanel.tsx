import { Link } from 'react-router-dom';
import type { Measurement, Page } from '../api';

/** One row of the review form. `id` is absent for a row added in this session. */
export interface DraftMeasurement {
  key: string;
  id?: string;
  name: string;
  /** Kept while the name is not changed, so a correction to the value does not move it to another trend. */
  canonical: string;
  value: string;
  unit: string;
  ref_low: string;
  ref_high: string;
  taken_on: string;
  page_id: string;
  removed: boolean;
}

const shown = (n: number | null) => (n === null ? '' : String(Number(n.toFixed(4))));

export const draftMeasurement = (m: Measurement): DraftMeasurement => ({
  key: m.id, id: m.id, name: m.name, canonical: m.canonical, value: m.value_text, unit: m.unit ?? '',
  ref_low: shown(m.ref_low), ref_high: shown(m.ref_high), taken_on: m.taken_on ?? '', page_id: m.page_id, removed: false,
});

const FLAG_STYLE: Record<string, string> = {
  high: 'bg-red-100 text-red-700',
  low: 'bg-amber-100 text-amber-700',
  normal: 'bg-green-100 text-green-700',
};

const range = (m: Measurement) =>
  m.ref_low !== null && m.ref_high !== null ? `${shown(m.ref_low)}–${shown(m.ref_high)}`
    : m.ref_high !== null ? `≤ ${shown(m.ref_high)}`
      : m.ref_low !== null ? `≥ ${shown(m.ref_low)}` : '';

/** Reading mode: each result with its range and flag. A numeric one links to its trend. */
export function MeasurementsList({ items, onHover }: { items: Measurement[]; onHover?: (m: Measurement | null) => void }) {
  return (
    <div className="space-y-1">
      {items.map(m => (
        <div
          key={m.id}
          onMouseEnter={() => onHover?.(m)} onMouseLeave={() => onHover?.(null)}
          className="flex items-baseline justify-between gap-3 p-2 text-xs rounded-lg border border-transparent hover:bg-gray-50"
        >
          <span className="min-w-0">
            {m.value_num !== null ? (
              <Link to={`/trends?name=${encodeURIComponent(m.canonical)}`} className="font-medium text-gray-700 hover:text-blue-600 break-words">{m.name}</Link>
            ) : (
              <span className="font-medium text-gray-700 break-words">{m.name}</span>
            )}
            {range(m) && <span className="block text-gray-400">ref {range(m)}{m.unit ? ` ${m.unit}` : ''}</span>}
          </span>
          <span className="text-right shrink-0">
            <span className="text-gray-900">{m.value_text}</span>
            {m.unit && <span className="text-gray-400"> {m.unit}</span>}
            {m.flag && m.flag !== 'normal' && (
              <span className={`ml-2 px-1.5 py-0.5 rounded-full font-medium ${FLAG_STYLE[m.flag]}`}>{m.flag}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

const cell = 'w-full text-xs border border-gray-200 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500';

/** Review mode: every part of a result is editable; the flag is worked out again on save. */
export function MeasurementsEditor({ rows, pages, currentPageId, onChange, onAdd, listId }: {
  rows: DraftMeasurement[];
  pages: Page[];
  currentPageId: string;
  onChange: (key: string, patch: Partial<DraftMeasurement>) => void;
  onAdd: () => void;
  listId: string;
}) {
  const live = rows.filter(r => !r.removed);
  return (
    <div className="space-y-3">
      {live.map(r => (
        <div key={r.key} className="border border-gray-100 rounded-lg p-2 space-y-2">
          <div className="flex gap-2">
            <input
              aria-label="Test name" placeholder="Test" list={listId} className={`${cell} font-medium`}
              // A renamed test is a different test: let the server derive its trend name from the new one.
              value={r.name} onChange={e => onChange(r.key, { name: e.target.value, canonical: '' })}
            />
            <button type="button" aria-label="Remove measurement" className="text-gray-400 hover:text-red-600 px-1" onClick={() => onChange(r.key, { removed: true })}>✕</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input aria-label="Value" placeholder="Value" className={cell} value={r.value} onChange={e => onChange(r.key, { value: e.target.value })} />
            <input aria-label="Unit" placeholder="Unit" className={cell} value={r.unit} onChange={e => onChange(r.key, { unit: e.target.value })} />
            <input aria-label="Reference low" placeholder="Ref. low" inputMode="decimal" className={cell} value={r.ref_low} onChange={e => onChange(r.key, { ref_low: e.target.value })} />
            <input aria-label="Reference high" placeholder="Ref. high" inputMode="decimal" className={cell} value={r.ref_high} onChange={e => onChange(r.key, { ref_high: e.target.value })} />
          </div>
          <div className="flex gap-2 items-center">
            <input
              aria-label="Date taken" placeholder="YYYY-MM-DD or YYYY-MM" inputMode="numeric" maxLength={10} className={cell}
              pattern="\d{4}-\d{2}(-\d{2})?" value={r.taken_on} onChange={e => onChange(r.key, { taken_on: e.target.value })}
            />
            {pages.length > 1 && (
              <select aria-label="Page" className={cell} value={r.page_id} onChange={e => onChange(r.key, { page_id: e.target.value })} disabled={!!r.id}>
                {pages.map(p => <option key={p.id} value={p.id}>Page {p.page_number}</option>)}
              </select>
            )}
          </div>
        </div>
      ))}
      {live.length === 0 && <p className="text-xs text-gray-400">No measurements</p>}
      <div className="flex items-center gap-3">
        <button type="button" onClick={onAdd} disabled={pages.length === 0 && !currentPageId} className="text-xs text-blue-600 hover:underline disabled:text-gray-300">+ Add measurement</button>
        {rows.some(r => r.removed) && (
          <span className="text-xs text-gray-400">
            {rows.filter(r => r.removed).length} removed.{' '}
            <button type="button" className="text-blue-600 hover:underline" onClick={() => rows.filter(r => r.removed).forEach(r => onChange(r.key, { removed: false }))}>Undo</button>
          </span>
        )}
      </div>
    </div>
  );
}
