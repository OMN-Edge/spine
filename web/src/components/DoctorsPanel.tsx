import { Link } from 'react-router-dom';
import type { DoctorOnDocument, DoctorRole } from '../api';

export interface DraftDoctor {
  key: string;
  name: string;
  specialty: string;
  role: DoctorRole;
}

export const ROLE_LABELS: Record<DoctorRole, string> = {
  author: 'Wrote it',
  prescriber: 'Prescribed',
  referrer: 'Referred',
  other: 'Mentioned',
};

export const draftDoctor = (d: DoctorOnDocument): DraftDoctor => ({ key: `${d.id}-${d.role}`, name: d.name, specialty: d.specialty ?? '', role: d.role });

/** Reading mode: who this document names, each linking to their page in the directory. */
export function DoctorsList({ doctors }: { doctors: DoctorOnDocument[] }) {
  return (
    <div className="space-y-1">
      {doctors.map(d => (
        <Link key={`${d.id}-${d.role}`} to={`/doctors/${d.id}`} className="flex items-baseline justify-between gap-3 p-2 text-xs rounded-lg hover:bg-gray-50">
          <span className="min-w-0">
            <span className="font-medium text-gray-900 break-words">{d.name}</span>
            {d.specialty && <span className="block text-gray-400">{d.specialty}</span>}
          </span>
          <span className="text-gray-500 shrink-0">{ROLE_LABELS[d.role]}</span>
        </Link>
      ))}
    </div>
  );
}

const cell = 'w-full text-xs border border-gray-200 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500';

/**
 * Review mode. The names already in the directory are offered as you type, so a doctor you have
 * met before is chosen rather than spelled a second way.
 */
export function DoctorsEditor({ rows, known, onChange, onAdd, onRemove, listId }: {
  rows: DraftDoctor[];
  known: string[];
  onChange: (key: string, patch: Partial<DraftDoctor>) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
  listId: string;
}) {
  return (
    <div className="space-y-3">
      <datalist id={listId}>{known.map(n => <option key={n} value={n} />)}</datalist>
      {rows.map(r => (
        <div key={r.key} className="border border-gray-100 rounded-lg p-2 space-y-2">
          <div className="flex gap-2">
            <input aria-label="Doctor name" placeholder="Name" list={listId} className={`${cell} font-medium`} value={r.name} onChange={e => onChange(r.key, { name: e.target.value })} />
            <button type="button" aria-label="Remove doctor" className="text-gray-400 hover:text-red-600 px-1" onClick={() => onRemove(r.key)}>✕</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input aria-label="Specialty" placeholder="Specialty" className={cell} value={r.specialty} onChange={e => onChange(r.key, { specialty: e.target.value })} />
            <select aria-label="Role" className={cell} value={r.role} onChange={e => onChange(r.key, { role: e.target.value as DoctorRole })}>
              {(Object.keys(ROLE_LABELS) as DoctorRole[]).map(role => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
            </select>
          </div>
        </div>
      ))}
      {rows.length === 0 && <p className="text-xs text-gray-400">No doctors</p>}
      <button type="button" onClick={onAdd} className="text-xs text-blue-600 hover:underline">+ Add doctor</button>
    </div>
  );
}
