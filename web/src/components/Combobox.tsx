import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';

export interface ComboOption {
  value: string;
  label: string;
  /** Shown beside the label, and searched too (a specialty, a count). */
  hint?: string;
}

const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const FIELD = 'w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-400';

/**
 * A dropdown you can type into: the list narrows as you type (case, accents and word order do not matter),
 * arrows and Enter choose, Escape closes. With `newLabel` the typed text can also be added as something new,
 * which calls `onChange(text, true)`; a value that is not among the options is shown as it is.
 */
export function Combobox({ id, ariaLabel, options, value, onChange, placeholder, className = FIELD, wrapperClassName = 'relative w-full', disabled, newLabel, commitOnBlur }: {
  id?: string;
  ariaLabel?: string;
  options: ComboOption[];
  value: string;
  onChange: (value: string, isNew?: boolean) => void;
  placeholder?: string;
  className?: string;
  wrapperClassName?: string;
  disabled?: boolean;
  /** Offers the typed text as a new entry, worded by this. */
  newLabel?: (text: string) => string;
  /** Typed text left in the box when focus moves on is taken as a new entry (a name being typed, not chosen). */
  commitOnBlur?: boolean;
}) {
  const { t } = useI18n();
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);

  const chosen = options.find(o => o.value === value);
  const shown = chosen?.label ?? value;
  const typed = query.trim();

  const matches = useMemo(() => {
    const words = fold(typed).split(/\s+/).filter(Boolean);
    if (words.length === 0) return options;
    return options.filter(o => {
      const hay = fold(`${o.label} ${o.hint ?? ''}`);
      return words.every(w => hay.includes(w));
    });
  }, [options, typed]);

  // The entries on offer: the matches, then "add" for the typed text.
  const entries: Array<{ option?: ComboOption; add?: string }> = [
    ...matches.map(option => ({ option })),
    ...(newLabel && typed ? [{ add: typed }] : []),
  ];

  useEffect(() => { setAt(0); }, [typed, open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const pick = (entry: { option?: ComboOption; add?: string } | undefined) => {
    if (!entry) return;
    if (entry.option) onChange(entry.option.value);
    else if (entry.add) onChange(entry.add, true);
    setOpen(false);
    setQuery('');
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setAt(i => Math.min(entries.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && open) { e.preventDefault(); pick(entries[at]); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setQuery(''); }
  };

  return (
    <div ref={box} className={wrapperClassName}>
      <input
        id={id} type="text" role="combobox" aria-label={ariaLabel} aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        autoComplete="off" disabled={disabled} placeholder={placeholder}
        className={`${className} pr-7`}
        value={open ? query : shown}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={e => { setOpen(true); setQuery(''); e.currentTarget.select(); }}
        onClick={() => setOpen(true)}
        onBlur={() => { if (commitOnBlur && newLabel && typed && typed !== shown) onChange(typed, true); }}
        onKeyDown={onKey}
      />
      <span aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">▾</span>
      {open && (
        <ul id={listId} role="listbox" className="absolute z-30 left-0 right-0 mt-1 max-h-60 overflow-auto bg-white border border-gray-200 rounded-lg shadow-lg py-1 text-sm">
          {entries.length === 0 && <li className="px-3 py-1.5 text-gray-400">{t('No match')}</li>}
          {entries.map((entry, i) => (
            <li
              key={entry.option ? `o-${entry.option.value}` : 'add'} role="option" aria-selected={entry.option ? entry.option.value === value : false}
              onMouseDown={e => { e.preventDefault(); pick(entry); }} onMouseEnter={() => setAt(i)}
              className={`px-3 py-1.5 cursor-pointer flex items-baseline justify-between gap-3 ${i === at ? 'bg-blue-50' : ''} ${entry.add ? 'text-blue-700' : 'text-gray-900'}`}
            >
              {entry.option ? (
                <>
                  <span className={`min-w-0 break-words ${entry.option.value === value ? 'font-medium' : ''}`}>{entry.option.label}</span>
                  {entry.option.hint && <span className="text-xs text-gray-400 shrink-0">{entry.option.hint}</span>}
                </>
              ) : <span>{newLabel!(entry.add!)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Several values, shown as chips, added by choosing from the options or typing a new one. The value is the list.
 */
export function ChipPicker({ id, ariaLabel, options, value, onChange, placeholder, newLabel }: {
  id?: string;
  ariaLabel?: string;
  options: ComboOption[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  newLabel?: (text: string) => string;
}) {
  const { t } = useI18n();
  const left = options.filter(o => !value.some(v => fold(v) === fold(o.value)));
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map(v => (
            <span key={v} className="inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-700 text-xs pl-2.5 pr-1.5 py-0.5">
              {v}
              <button type="button" aria-label={t('Remove {name}', { name: v })} className="text-gray-400 hover:text-red-600" onClick={() => onChange(value.filter(x => x !== v))}>✕</button>
            </span>
          ))}
        </div>
      )}
      <Combobox
        id={id} ariaLabel={ariaLabel} options={left} value="" placeholder={placeholder} newLabel={newLabel}
        onChange={(v, isNew) => { const name = v.trim(); if (name && !value.some(x => fold(x) === fold(name))) onChange([...value, name]); void isNew; }}
      />
    </div>
  );
}
