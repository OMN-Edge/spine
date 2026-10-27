import { Link } from 'react-router-dom';
import type { DoctorOnDocument, DoctorRole } from '../api';
import { msg, useI18n } from '../i18n';
import { Combobox } from './Combobox';

export interface DraftDoctor {
  key: string;
  /** The directory entry this row is, if it came from the document; kept when the name is left as it was. */
  id?: string;
  /** Its professional code, shown beside the name (not edited here: it belongs to the directory entry). */
  code?: string | null;
  /** Typed as a person not in the directory, even if the name is: a second doctor of that name. */
  isNew?: boolean;
  name: string;
  specialty: string;
  role: DoctorRole;
}

export const ROLE_LABELS: Record<DoctorRole, string> = {
  author: msg('Wrote it'),
  prescriber: msg('Prescribed'),
  referrer: msg('Referred'),
  other: msg('Mentioned'),
};

export const draftDoctor = (d: DoctorOnDocument): DraftDoctor => ({ key: `${d.id}-${d.role}`, id: d.id, code: d.license_code, name: d.name, specialty: d.specialty ?? '', role: d.role });

/** Reading mode: who this document names, each linking to their page in the directory. */
export function DoctorsList({ doctors, plain = false }: { doctors: Array<Pick<DoctorOnDocument, 'id' | 'name' | 'specialty' | 'role'> & { license_code?: string | null; signature_verified?: boolean }>; plain?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="space-y-1">
      {doctors.map(d => {
        const inside = (
          <>
            <span className="min-w-0">
              <span className="font-medium text-gray-900 break-words">{d.name}</span>
              {d.specialty && <span className="block text-gray-400">{d.specialty}</span>}
              {/* The code is the owner's to see on their own pages; a recipient's list never carries it. */}
              {!plain && !!d.signature_verified && <span className="block text-green-700" title={t('The certificates in the file lead to an authority this server trusts')}>{t('Digital signature verified')}</span>}
              {!plain && d.license_code && <span className="block text-gray-400" title={t('Professional code')}>{t('Code {code}', { code: d.license_code })}</span>}
            </span>
            <span className="text-gray-500 shrink-0">{t(ROLE_LABELS[d.role] ?? ROLE_LABELS.other)}</span>
          </>
        );
        const row = 'flex items-baseline justify-between gap-3 p-2 text-xs rounded-lg';
        // A recipient has no directory to go to: the owner's pages are not theirs to open.
        return plain
          ? <div key={`${d.id}-${d.role}`} className={row}>{inside}</div>
          : <Link key={`${d.id}-${d.role}`} to={`/doctors/${d.id}`} className={`${row} hover:bg-gray-50`}>{inside}</Link>;
      })}
    </div>
  );
}

const cell = 'w-full text-xs border border-gray-200 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-500';

/** A doctor in the directory, as the editor offers them. */
export interface DoctorChoice { id: string; name: string; specialty: string | null; license_code: string | null }

/**
 * Review mode. Each row is a doctor chosen from the directory (search by name, specialty or code), or a new
 * one typed in: that is also how a second person with a name already held is added.
 */
export function DoctorsEditor({ rows, known, onChange, onAdd, onRemove }: {
  rows: DraftDoctor[];
  known: DoctorChoice[];
  onChange: (key: string, patch: Partial<DraftDoctor>) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
}) {
  const { t } = useI18n();
  const options = known.map(d => ({ value: d.id, label: d.name, hint: [d.specialty, d.license_code].filter(Boolean).join(' · ') || undefined }));
  return (
    <div className="space-y-3">
      {rows.map(r => (
        <div key={r.key} className="border border-gray-100 rounded-lg p-2 space-y-2">
          <div className="flex gap-2">
            <Combobox
              ariaLabel={t('Doctor name')} placeholder={t('Search or add a doctor')} className={`${cell} font-medium`}
              // A row not in the directory yet shows its typed name; one that is shows the entry's.
              options={r.id && !known.some(d => d.id === r.id) ? [...options, { value: r.id, label: r.name }] : options}
              value={r.id ?? r.name}
              onChange={(v, isNew) => {
                if (isNew) return onChange(r.key, { id: undefined, code: null, isNew: true, name: v });
                const d = known.find(x => x.id === v);
                if (d) onChange(r.key, { id: d.id, code: d.license_code, isNew: false, name: d.name, specialty: d.specialty ?? '' });
              }}
              newLabel={name => t('Add “{name}” as a new doctor', { name })}
            />
            <button type="button" aria-label={t('Remove doctor')} className="text-gray-400 hover:text-red-600 px-1" onClick={() => onRemove(r.key)}>✕</button>
          </div>
          {r.code && <p className="text-xs text-gray-400" title={t('Professional code')}>{t('Code {code}', { code: r.code })}</p>}
          <div className="grid grid-cols-2 gap-2">
            <input aria-label={t('Specialty')} placeholder={t('Specialty')} className={cell} value={r.specialty} onChange={e => onChange(r.key, { specialty: e.target.value })} />
            <Combobox
              ariaLabel={t('Role')} className={cell} value={r.role} onChange={v => onChange(r.key, { role: v as DoctorRole })}
              options={(Object.keys(ROLE_LABELS) as DoctorRole[]).map(role => ({ value: role, label: t(ROLE_LABELS[role]) }))}
            />
          </div>
        </div>
      ))}
      {rows.length === 0 && <p className="text-xs text-gray-400">{t('No doctors')}</p>}
      <button type="button" onClick={onAdd} className="text-xs text-brand-600 hover:underline">+ {t('Add doctor')}</button>
    </div>
  );
}
