import { useI18n } from '../i18n';

/**
 * What a typed date becomes: the digits, with the dashes put in as they are typed, so a phone's number pad (which has no dash) can write
 * 2024-03-12, 2024-03 or 2024. A date written day first with dots or slashes, as it is pasted from a letter, is turned round.
 */
export function typedDate(raw: string): string {
  const dayFirst = /^\s*(\d{1,2})[./](\d{1,2})[./](\d{4})\s*$/.exec(raw);
  if (dayFirst) return `${dayFirst[3]}-${dayFirst[2].padStart(2, '0')}-${dayFirst[1].padStart(2, '0')}`;
  const d = raw.replace(/\D/g, '').slice(0, 8);
  return d.slice(0, 4) + (d.length > 4 ? `-${d.slice(4, 6)}` : '') + (d.length > 6 ? `-${d.slice(6)}` : '');
}

/**
 * A date field: typed (year-month-day, or only the year and month, or the year, where the field takes those) or chosen on the browser's
 * own calendar from the button at its end. The calendar is a native date input laid invisibly over the button, because a phone opens its
 * picker only for a tap on one; `showPicker()` opens it for a desktop browser, which would otherwise wait for a click on its own icon.
 * `className` styles the field; its margins go to the wrapper, so the button stays centred on the field.
 */
export function DateInput({ value, onChange, className = '', min, max, ...rest }: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  min?: string;
  max?: string;
  'aria-label'?: string;
  placeholder?: string;
  id?: string;
}) {
  const { t } = useI18n();
  const classes = className.split(/\s+/);
  const isMargin = (c: string) => /^m[trblxy]?-/.test(c);
  const full = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
  return (
    <span className={`relative block ${classes.filter(isMargin).join(' ')}`}>
      <input
        {...rest} value={value} onChange={e => onChange(typedDate(e.target.value))}
        inputMode="numeric" autoComplete="off" maxLength={10} className={`${classes.filter(c => !isMargin(c)).join(' ')} pr-9`}
      />
      <span className="absolute right-1 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700">
        <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="3" y="4.5" width="14" height="12" rx="2" /><path d="M3 8.5h14M7 2.5v4M13 2.5v4" strokeLinecap="round" />
        </svg>
        <input
          type="date" aria-label={t('Choose on a calendar')} title={t('Choose on a calendar')} value={full} min={min} max={max}
          onChange={e => { if (e.target.value) onChange(e.target.value); }}
          onClick={e => { try { e.currentTarget.showPicker(); } catch { /* the browser opens it itself, or has no picker */ } }}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </span>
    </span>
  );
}
