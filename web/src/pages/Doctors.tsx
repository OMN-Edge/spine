import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type DoctorEntry } from '../api';

export default function Doctors() {
  const [doctors, setDoctors] = useState<DoctorEntry[] | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => { api.doctors.list().then(setDoctors).catch(() => setDoctors([])); }, []);

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
