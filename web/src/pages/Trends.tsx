import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type Flag, type TrendName, type TrendSeries } from '../api';
import TrendChart from '../components/TrendChart';

const FLAG_STYLE: Record<string, string> = {
  high: 'bg-red-100 text-red-700',
  low: 'bg-amber-100 text-amber-700',
  normal: 'bg-green-100 text-green-700',
};

function FlagBadge({ flag }: { flag: Flag | null }) {
  if (!flag || flag === 'normal') return null;
  return <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${FLAG_STYLE[flag]}`}>{flag}</span>;
}

const range = (low: number | null, high: number | null) =>
  low !== null && high !== null ? `${low}–${high}` : high !== null ? `≤ ${high}` : low !== null ? `≥ ${low}` : '';

function TestList({ names }: { names: TrendName[] }) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => names.filter(n => n.name.toLowerCase().includes(query.trim().toLowerCase())), [names, query]);
  return (
    <>
      <input
        type="search" aria-label="Filter tests" placeholder="Filter tests…" value={query} onChange={e => setQuery(e.target.value)}
        className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {shown.length === 0 ? <p className="text-sm text-gray-400">No test matches.</p> : (
        <ul className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
          {shown.map(n => (
            <li key={n.canonical}>
              <Link to={`/trends?name=${encodeURIComponent(n.canonical)}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50">
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-gray-900 truncate">{n.name}</span>
                  <span className="block text-xs text-gray-400">{n.count} {n.count === 1 ? 'value' : 'values'}{n.latest_taken_on ? ` · latest ${n.latest_taken_on}` : ''}</span>
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

/** For a test written two ways by two labs: count this one as another, and remember it for later documents. */
function MergeTest({ canonical, others }: { canonical: string; others: TrendName[] }) {
  const navigate = useNavigate();
  const [into, setInto] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (others.length === 0) return null;

  const merge = async () => {
    setBusy(true); setError('');
    try {
      await api.trends.merge(canonical, into);
      navigate(`/trends?name=${encodeURIComponent(into)}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not merge');
      setBusy(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 mt-4">
      <h2 className="font-medium text-gray-900 mb-1 text-sm">Same test under another name?</h2>
      <p className="text-xs text-gray-500 mb-3">
        Labs name a test differently. Choose the one this should be counted with: these values move there, and a later
        document that uses this name is filed there too. To split them again, edit the values in their documents.
      </p>
      <div className="flex gap-2">
        <select aria-label="Count this test as" className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5" value={into} onChange={e => setInto(e.target.value)}>
          <option value="">Choose a test…</option>
          {others.map(o => <option key={o.canonical} value={o.canonical}>{o.name} ({o.count})</option>)}
        </select>
        <button onClick={merge} disabled={!into || busy} className="shrink-0 px-4 py-1.5 rounded-lg text-sm border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">Merge</button>
      </div>
      {error && <p className="text-sm text-red-600 mt-2" role="alert">{error}</p>}
    </div>
  );
}

function Series({ canonical, others }: { canonical: string; others: TrendName[] }) {
  const [series, setSeries] = useState<TrendSeries | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setSeries(null); setError('');
    api.trends.series(canonical).then(setSeries).catch(err => setError(err instanceof Error ? err.message : 'Could not load'));
  }, [canonical]);

  if (error) return <p className="text-sm text-red-600" role="alert">{error}</p>;
  if (!series) return <p className="text-sm text-gray-400">Loading…</p>;

  const notDrawn = series.points.filter(p => !p.charted).length;
  const drawn = series.points.length - notDrawn;
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold text-gray-900 mb-1">{series.name}</h1>
      <p className="text-sm text-gray-500 mb-4">{series.points.length} {series.points.length === 1 ? 'value' : 'values'}{series.unit ? `, in ${series.unit}` : ''}</p>

      {drawn > 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-3 sm:p-4 mb-3">
          <TrendChart points={series.points} unit={series.unit} />
          <p className="text-xs text-gray-400 mt-2">
            The shaded band is the reference range printed on the newest value. Select a point to open its document.
          </p>
        </div>
      ) : (
        <p className="text-sm text-gray-500 mb-3">Nothing here can be drawn: the values are not numbers, or have no date.</p>
      )}
      {notDrawn > 0 && drawn > 0 && (
        <p className="text-xs text-gray-500 mb-3">
          {notDrawn} {notDrawn === 1 ? 'value is' : 'values are'} listed but not drawn: in another unit, not a number, without a date, or repeating a value that is drawn.
        </p>
      )}

      <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-400">
              <th className="font-medium px-4 py-2">Date</th>
              <th className="font-medium px-2 py-2">Value</th>
              <th className="font-medium px-2 py-2">Reference</th>
              <th className="font-medium px-4 py-2">Document</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {[...series.points].reverse().map(p => (
              <tr key={p.id}>
                <td className="px-4 py-2 whitespace-nowrap text-gray-700">{p.taken_on ?? '—'}</td>
                <td className="px-2 py-2 whitespace-nowrap">
                  <span className="text-gray-900">{p.value_text}</span>{p.unit && <span className="text-gray-400"> {p.unit}</span>} <FlagBadge flag={p.flag} />
                </td>
                <td className="px-2 py-2 whitespace-nowrap text-gray-400">{range(p.ref_low, p.ref_high)}</td>
                <td className="px-4 py-2"><Link to={`/documents/${p.document_id}`} className="text-blue-600 hover:underline">{p.document_title ?? 'Document'}</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <MergeTest canonical={canonical} others={others} />
    </div>
  );
}

export default function Trends() {
  const [params] = useSearchParams();
  const name = params.get('name');
  const [names, setNames] = useState<TrendName[] | null>(null);

  // Again whenever the page changes: a merge leaves one name fewer.
  useEffect(() => { api.trends.names().then(setNames).catch(() => setNames([])); }, [name]);

  return (
    <div>
      {name ? (
        <>
          <Link to="/trends" className="text-xs text-gray-400 hover:text-gray-600 block mb-3">← All tests</Link>
          <Series canonical={name} others={(names ?? []).filter(n => n.canonical !== name)} />
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold text-gray-900 mb-1">Trends</h1>
          <p className="text-sm text-gray-500 mb-4">Lab values and vitals from your documents, over time.</p>
          {names === null ? <p className="text-sm text-gray-400">Loading…</p>
            : names.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <p className="text-lg mb-2">No measurements yet</p>
                <p className="text-sm">They appear when a lab result or a note with vitals is read.</p>
              </div>
            ) : <TestList names={names} />}
        </>
      )}
    </div>
  );
}
