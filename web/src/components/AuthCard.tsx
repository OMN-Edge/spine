import type { ReactNode } from 'react';
import { LogoMark } from './Logo';
import { Link } from 'react-router-dom';
import { LanguageSwitcher, useI18n } from '../i18n';

/** The centred card the sign-in, signup and recovery pages share. */
export default function AuthCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="bg-white p-6 sm:p-8 rounded-2xl shadow-[0_1px_2px_rgb(22_24_29/0.04),0_8px_24px_-12px_rgb(22_24_29/0.12)] border border-gray-200 w-full max-w-sm">
        <div className="flex items-start justify-between">
          <Link to="/" aria-label={t('Home')}><LogoMark className="h-9 w-9 text-brand-600 mb-4" /></Link>
          <LanguageSwitcher />
        </div>
        <h1 className="text-[1.75rem] leading-tight font-light tracking-tight text-gray-900 mb-6">{title}</h1>
        {children}
        {footer && <div className="mt-5 text-sm text-gray-500 space-y-1">{footer}</div>}
        <p className="mt-5 text-xs text-gray-500 flex flex-wrap gap-x-3 gap-y-1">
          <Link to="/privacy" className="hover:underline">{t('Privacy notice')}</Link>
          <Link to="/terms" className="hover:underline">{t('Terms of use')}</Link>
          <Link to="/purpose" className="hover:underline">{t('What Spine is for')}</Link>
        </p>
      </div>
    </div>
  );
}

export const inputClass =
  'w-full border border-gray-300 rounded-lg bg-white px-4 py-2 mb-3 placeholder:text-gray-500 focus:outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/25';

export const buttonClass =
  'w-full bg-brand-600 text-white rounded-full px-4 py-2 font-medium hover:bg-brand-700 disabled:opacity-50';

export function Notice({ kind, children }: { kind: 'error' | 'ok'; children: ReactNode }) {
  return (
    <p className={`text-sm mb-3 ${kind === 'error' ? 'text-red-600' : 'text-green-700'}`}>{children}</p>
  );
}
