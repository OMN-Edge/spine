import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { api } from '../api';
import { msg, useI18n } from '../i18n';
import { useOnDataChanged } from '../dataChanged';
import { PROFILE_CHANGED } from '../core/client';
import { LanguageSwitcher } from './LanguageSwitcher';
import { ThemeSwitcher } from './ThemeSwitcher';

/** The pages that are not in the bar itself: what was read, gathered, and the card for an emergency. */
export const MORE_LINKS = [
  { to: '/episodes', label: msg('Episodes') },
  { to: '/reminders', label: msg('Reminders') },
  { to: '/trends', label: msg('Trends') },
  { to: '/doctors', label: msg('Doctors') },
  { to: '/library', label: msg('Library') },
  { to: '/emergency', label: msg('Emergency card') },
];

/** A menu opened from the top bar closes on a click outside it, on Escape, and when a link in it is followed. */
function useMenu() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', escape); };
  }, [open]);
  return { open, setOpen, box };
}

/**
 * How many documents wait for review, shown beside Review so the queue is noticed without being opened. Read again when a page changes,
 * when the chat changes something, and when another person's records are opened.
 */
export function useReviewCount(enabled: boolean): number {
  const [count, setCount] = useState(0);
  const location = useLocation();
  const read = useCallback(() => {
    if (!enabled) return;
    api.documents.listAll({ reviewed: 'false' }).then(docs => setCount(docs.length)).catch(() => {});
  }, [enabled]);
  useEffect(read, [read, location.pathname]);
  useOnDataChanged(read);
  useEffect(() => {
    window.addEventListener(PROFILE_CHANGED, read);
    return () => window.removeEventListener(PROFILE_CHANGED, read);
  }, [read]);
  return count;
}

/** The count beside Review: nothing when none wait. */
export function ReviewBadge({ count }: { count: number }) {
  const { tn } = useI18n();
  if (count === 0) return null;
  return (
    <span className="ml-1.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-amber-100 px-1.5 text-xs font-medium text-amber-800" aria-label={tn(count, '{n} document waiting for review', '{n} documents waiting for review')}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

/** "More": the pages that do not fit in the bar, each a link. Shown as active when one of them is open. */
export function MoreMenu({ links }: { links: typeof MORE_LINKS }) {
  const { t } = useI18n();
  const { open, setOpen, box } = useMenu();
  const location = useLocation();
  const here = links.some(l => location.pathname.startsWith(l.to));
  return (
    <div ref={box} className="relative">
      <button
        type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-haspopup="menu"
        className={`flex items-center gap-1 text-sm ${here ? 'text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-900'}`}
      >
        {t('More')}<span aria-hidden className="text-gray-400 text-xs">▾</span>
      </button>
      {open && (
        <div role="menu" className="absolute left-0 z-50 mt-2 w-56 rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-lg">
          {links.map(link => (
            <NavLink
              key={link.to} to={link.to} role="menuitem"
              className={({ isActive }) => `block px-3 py-1.5 hover:bg-brand-50 ${link.to === '/emergency' ? 'border-t border-gray-100 mt-1 pt-2' : ''} ${isActive ? 'text-gray-900 font-medium' : 'text-gray-700'}`}
            >
              {t(link.label)}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The account's corner: one round button with the first letter of the address, opening the address, the account page, the language and
 * the look, and Sign out. The demo has no account, so it shows the language, the look and Leave the demo instead.
 */
export function AccountMenu({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const { t } = useI18n();
  const { open, setOpen, box } = useMenu();
  const initial = (email.trim()[0] ?? '?').toUpperCase();
  return (
    <div ref={box} className="relative">
      <button
        type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-haspopup="menu" aria-label={t('Account and settings')} title={email}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-medium text-white hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
      >
        {initial}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-50 mt-2 w-72 rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-lg">
          <p className="px-3 pt-2 pb-1 text-xs text-gray-500">{t('Signed in as')}</p>
          <p className="px-3 pb-2 text-gray-900 truncate border-b border-gray-100">{email}</p>
          <Link role="menuitem" to="/account" className="block px-3 py-2 text-gray-700 hover:bg-brand-50">{t('Account')}</Link>
          <Link role="menuitem" to="/profiles" className="block px-3 py-2 text-gray-700 hover:bg-brand-50">{t('Add or manage people')}</Link>
          <div className="flex items-center justify-between gap-2 border-t border-gray-100 px-3 py-2">
            <LanguageSwitcher />
            <ThemeSwitcher />
          </div>
          <button role="menuitem" type="button" onClick={onSignOut} className="block w-full border-t border-gray-100 px-3 py-2 text-left text-gray-700 hover:bg-brand-50">{t('Sign out')}</button>
        </div>
      )}
    </div>
  );
}
