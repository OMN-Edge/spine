import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type DoctorEntry, type DoctorSummary } from '../api';

const DISMISSED = 'spine.doctors-not-the-same';
const pairKey = (a: string, b: string) => [a, b].sort().join('|');
const readDismissed = (): string[] => { try { return JSON.parse(localStorage.getItem(DISMISSED) ?? '[]'); } catch { return []; } };
const writeDismissed = (keys: string[]) => { try { localStorage.setItem(DISMISSED, JSON.stringify(keys)); } catch { /* a convenience only */ } };

const describe = (d: DoctorSummary) =>
  `${d.name}${d.specialty ? ` (${d.specialty})` : ''}, ${d.document_count} ${d.document_count === 1 ? 'document' : 'documents'}`;

/**
 * Entries that are probably one person written two ways. Never merged by itself: it cannot know, so the owner
 * says yes (merge into the fuller name) or "not the same", which is remembered in this browser only.
 */
function Duplicates({ onMerged }: { onMerged: () => void }) {
  const [pairs, setPairs] = useState<Array<{ keep: DoctorSummary; other: DoctorSummary }>>([]);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const [error, setError] = useState('');
  useEffect(() => { api.doctors.duplicates().then(setPairs).catch(() => setPairs([])); }, []);

  const shown = pairs.filter(p => !dismissed.includes(pairKey(p.keep.id, p.other.id)));
  if (shown.length === 0) return null;

  const merge = async (p: (typeof pairs)[number]) => {
    setError('');
    try {
      await api.doctors.merge(p.keep.id, p.other.id);
      setPairs(prev => prev.filter(x => x !== p));
      onMerged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not merge');
    }
  };
  const dismiss = (p: (typeof pairs)[number]) => {
    const next = [...dismissed, pairKey(p.keep.id, p.other.id)];
    setDismissed(next);
    writeDismissed(next);
  };

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4" aria-label="Possible duplicates">
      <h2 className="text-sm font-medium text-amber-900 mb-1">Probably the same person</h2>
      <p className="text-xs text-amber-800 mb-3">Written two ways on different documents. Merging keeps every document under the fuller name.</p>
      <ul className="space-y-3">
        {shown.map(p => (
          <li key={pairKey(p.keep.id, p.other.id)} className="text-sm text-gray-800">
            <p>{describe(p.other)} <span className="text-gray-400">and</span> {describe(p.keep)}</p>
            <div className="flex gap-3 mt-1">
              <button type="button" onClick={() => merge(p)} className="text-blue-600 hover:underline">Merge into {p.keep.name}</button>
              <button type="button" onClick={() => dismiss(p)} className="text-gray-500 hover:underline">Not the same</button>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="text-sm text-red-600 mt-2" role="alert">{error}</p>}
    </div>
  );
}

export default function Doctors() {
  const [doctors, setDoctors] = useState<DoctorEntry[] | null>(null);
  const [query, setQuery] = useState('');

  const reload = () => { api.doctors.list().then(setDoctors).catch(() => setDoctors([])); };
  useEffect(reload, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (doctors ?? []).filter(d => !q || [d.name, d.specialty, d.clinic].some(v => v?.toLowerCase().includes(q)));
  }, [doctors, query]);

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900 mb-1">Doctors</h1>
      <p className="text-sm text-gray-500 mb-4">Everyone your documents name. The list grows as documents are read.</p>
      {doctors === null ? <p className="text-sm text-gray-400">Loading…</p>
        : doctors.length === 0 ? (
          <div className="text-center py-16 text-gray-400"><p className="text-lg mb-2">No doctors yet</p><p className="text-sm">They are added as documents are read.</p></div>
        ) : (
          <>
            <Duplicates onMerged={reload} />
            <input
              type="search" aria-label="Filter doctors" placeholder="Filter by name, specialty or clinic…" value={query} onChange={e => setQuery(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {shown.length === 0 ? <p className="text-sm text-gray-400">No doctor matches.</p> : (
              <ul className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
                {shown.map(d => (
                  <li key={d.id}>
                    <Link to={`/doctors/${d.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50">
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-gray-900 truncate">{d.name}</span>
                        <span className="block text-xs text-gray-400 truncate">{[d.specialty, d.clinic].filter(Boolean).join(' · ') || 'No specialty yet'}</span>
                      </span>
                      <span className="text-right shrink-0 text-xs text-gray-500">
                        {d.document_count} {d.document_count === 1 ? 'document' : 'documents'}
                        {d.last_seen && <span className="block text-gray-400">last {d.last_seen}</span>}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
    </div>
  );
}
