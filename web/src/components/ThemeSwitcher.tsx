import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { currentLook, toggleLook, watchLook } from '../theme';

/** A round button beside the language picker: a moon in the light look, a sun in the dark one. */
export function ThemeSwitcher({ className = '' }: { className?: string }) {
  const { t } = useI18n();
  const [look, setLook] = useState(currentLook);
  useEffect(() => watchLook(() => setLook(currentLook())), []);
  const label = look === 'dark' ? t('Switch to light mode') : t('Switch to dark mode');
  return (
    <button
      type="button" onClick={toggleLook} aria-label={label} title={label}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gray-300 text-gray-600 hover:bg-gray-100 hover:text-gray-900 ${className}`}
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {look === 'dark' ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" />
          </>
        ) : (
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
        )}
      </svg>
    </button>
  );
}
