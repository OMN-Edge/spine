import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { openPerson, type People } from '../profiles';
import { useI18n } from '../i18n';
import { TOP_BAR_CONTROL } from './LanguageSwitcher';

/**
 * Whose records are open, always in the header: one tap shows the other people this account keeps or was let into, opens another, or goes
 * to the page where people are added, invited and let in. With only one person it still shows, so the page of people can be found.
 */
export default function PersonMenu({ people }: { people: People }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const current = people.profiles.find(p => p.id === people.current);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', escape); };
  }, [open]);

  const choose = async (id: string) => {
    setOpen(false);
    if (id === people.current) return;
    // Something not saved yet: the page of people says so and lets the person decide.
    try { await openPerson(id); navigate('/'); } catch { navigate('/profiles'); }
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t('Whose records are open')}
        className={`flex items-center gap-2 max-w-[12rem] ${TOP_BAR_CONTROL}`}
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-brand-600" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" />
        </svg>
        <span className="truncate font-medium text-gray-900">{current?.name ?? t('People')}</span>
        <span aria-hidden className="text-gray-400 text-xs">▾</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-50 mt-1 w-64 rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-lg">
          {people.profiles.map(p => (
            <button
              key={p.id} role="menuitemradio" aria-checked={p.id === people.current} type="button" onClick={() => void choose(p.id)}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-gray-900 hover:bg-brand-50"
            >
              <span className="truncate">{p.name}{p.shared && <span className="block text-xs text-gray-500 truncate">{t('Shared by {owner}', { owner: p.shared.owner })}</span>}</span>
              {p.id === people.current && <span className="text-xs text-green-700">{t('Open now')}</span>}
            </button>
          ))}
          <Link role="menuitem" to="/profiles" onClick={() => setOpen(false)} className="block border-t border-gray-100 px-3 py-1.5 text-brand-700 hover:bg-brand-50">{t('Add or manage people')}</Link>
        </div>
      )}
    </div>
  );
}
