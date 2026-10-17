import type { ReactNode } from 'react';
import { LogoMark } from './Logo';
import { LanguageSwitcher } from '../i18n';

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
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="bg-white p-6 sm:p-8 rounded-xl shadow-sm border border-gray-200 w-full max-w-sm">
        <div className="flex items-start justify-between">
          <LogoMark className="h-9 w-9 text-blue-600 mb-4" />
          <LanguageSwitcher />
        </div>
        <h1 className="text-2xl font-semibold text-gray-900 mb-6">{title}</h1>
        {children}
        {footer && <div className="mt-5 text-sm text-gray-500 space-y-1">{footer}</div>}
      </div>
    </div>
  );
}

export const inputClass =
  'w-full border border-gray-300 rounded-lg px-4 py-2 mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500';

export const buttonClass =
  'w-full bg-blue-600 text-white rounded-lg px-4 py-2 font-medium hover:bg-blue-700 disabled:opacity-50';

export function Notice({ kind, children }: { kind: 'error' | 'ok'; children: ReactNode }) {
  return (
    <p className={`text-sm mb-3 ${kind === 'error' ? 'text-red-500' : 'text-green-700'}`}>{children}</p>
  );
}
