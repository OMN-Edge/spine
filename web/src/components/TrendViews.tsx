import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Flag, TrendName, TrendSeries } from '../api';
import TrendChart from './TrendChart';
import { useI18n } from '../i18n';

const FLAG_STYLE: Record<string, string> = {
  high: 'bg-red-100 text-red-700',
  low: 'bg-amber-100 text-amber-700',
  normal: 'bg-green-100 text-green-700',
};

export function FlagBadge({ flag }: { flag: Flag | null }) {
  const { t } = useI18n();
  if (!flag || flag === 'normal') return null;
  return <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${FLAG_STYLE[flag]}`}>{flag === 'high' ? t('high') : t('low')}</span>;
}

const range = (low: number | null, high: number | null) =>
  low !== null && high !== null ? `${low}–${high}` : high !== null ? `≤ ${high}` : low !== null ? `≥ ${low}` : '';

/** Every test with a value, filterable. `hrefFor` is where a test's page is: the owner's trends or a share's. */
export function TestList({ names, hrefFor }: { names: TrendName[]; hrefFor: (canonical: string) => string }) {
  const { t, tn } = useI18n();
  const [query, setQuery] = useState('');
  const shown = useMemo(() => names.filter(n => n.name.toLowerCase().includes(query.trim().toLowerCase())), [names, query]);
  return (
    <>
      <input
        type="search" aria-label={t('Filter tests')} placeholder={t('Filter tests…')} value={query} onChange={e => setQuery(e.target.value)}
        className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {shown.length === 0 ? <p className="text-sm text-gray-400">{t('No test matches.')}</p> : (
        <ul className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
          {shown.map(n => (
            <li key={n.canonical}>
              <Link to={hrefFor(n.canonical)} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50">
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-gray-900 truncate">{n.name}</span>
                  <span className="block text-xs text-gray-400">{tn(n.count, '{n} value', '{n} values')}{n.latest_taken_on ? ` · ${t('latest {date}', { date: n.latest_taken_on })}` : ''}</span>
                </span>
                <span className="text-right shrink-0 flex items-center gap-2">
                  <FlagBadge flag={n.latest_flag} />
                  <span className="text-sm text-gray-900">{n.latest_value_text}{n.unit && <span className="text-gray-400"> {n.unit}</span>}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}


/** One test over time: the chart and the table of its values. `documentHref` is where a value's document is; `after` is whatever the page adds below (the owner can merge two names). */
export function SeriesBody({ series, documentHref, after }: { series: TrendSeries; documentHref: (documentId: string) => string; after?: React.ReactNode }) {
  const { t, tn } = useI18n();
  const notDrawn = series.points.filter(p => !p.charted).length;
  const drawn = series.points.length - notDrawn;
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold text-gray-900 mb-1">{series.name}</h1>
      <p className="text-sm text-gray-500 mb-4">{tn(series.points.length, '{n} value', '{n} values')}{series.unit ? `, ${t('in {unit}', { unit: series.unit })}` : ''}</p>

      {drawn > 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-3 sm:p-4 mb-3">
          <TrendChart points={series.points} unit={series.unit} documentHref={documentHref} />
          <p className="text-xs text-gray-400 mt-2">
            {t('The shaded band is the reference range printed on the newest value. Select a point to open its document.')}
          </p>
        </div>
      ) : (
        <p className="text-sm text-gray-500 mb-3">{t('Nothing here can be drawn: the values are not numbers, or have no date.')}</p>
      )}
      {notDrawn > 0 && drawn > 0 && (
        <p className="text-xs text-gray-500 mb-3">
          {tn(notDrawn, '{n} value is listed but not drawn: in another unit, not a number, without a date, or repeating a value that is drawn.', '{n} values are listed but not drawn: in another unit, not a number, without a date, or repeating a value that is drawn.')}
        </p>
      )}

      <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-400">
              <th className="font-medium px-4 py-2">{t('Date')}</th>
              <th className="font-medium px-2 py-2">{t('Value')}</th>
              <th className="font-medium px-2 py-2">{t('Reference')}</th>
              <th className="font-medium px-4 py-2">{t('Document')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {[...series.points].reverse().map(p => (
              <tr key={p.id}>
                <td className="px-4 py-2 whitespace-nowrap text-gray-700">{p.taken_on ?? '—'}</td>
                <td className="px-2 py-2 whitespace-nowrap">
                  <span className="text-gray-900">{p.value_text}</span>{p.unit && <span className="text-gray-400"> {p.unit}</span>} <FlagBadge flag={p.flag as Flag | null} />
                </td>
                <td className="px-2 py-2 whitespace-nowrap text-gray-400">{range(p.ref_low, p.ref_high)}</td>
                <td className="px-4 py-2"><Link to={documentHref(p.document_id)} className="text-blue-600 hover:underline">{p.document_title ?? t('Document')}</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {after}
    </div>
  );
}
