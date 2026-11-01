import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import '@fontsource/literata/400.css';
import '@fontsource/literata/500.css';
import { api, type AuthOptions } from '../api';
import { useAuth } from '../auth';
import { LogoMark } from './Logo';
import { LanguageSwitcher, useI18n } from '../i18n';
import { ThemeSwitcher } from './ThemeSwitcher';
import { BUILD_COMMIT } from '../build-info';

/**
 * The pages a visitor reads before they have an account: the front page, how Spine works, how records are protected, and Spine for
 * families. One header and one footer, the instance's options read once, and the type and spacing they share. Every claim on these pages
 * is one SECURITY.md, the README or the help text (core/src/help.ts) makes; change one only together with the document it comes from.
 * The headings are set in Literata, bundled and used on these pages only (the policy allows fonts from this origin only).
 */
export type PublicOptions = Pick<AuthOptions, 'registration' | 'instance' | 'billing' | 'waitlist'>;

export function usePublicOptions(): PublicOptions {
  const [options, setOptions] = useState<PublicOptions>({ registration: 'operator', instance: 'public', billing: false, waitlist: false });
  useEffect(() => {
    api.auth.options().then(o => setOptions({ registration: o.registration, instance: o.instance, billing: o.billing, waitlist: o.waitlist })).catch(() => {});
  }, []);
  return options;
}

export function PublicPage({ options, children }: { options: PublicOptions; children: ReactNode }) {
  const { t } = useI18n();
  const links = [
    { to: '/how-it-works', label: t('How it works') },
    { to: '/protection', label: t('Protection') },
    { to: '/families', label: t('Families') },
    { to: '/for-doctors', label: t('For doctors') },
    ...(options.billing ? [{ to: '/pricing', label: t('Plans and prices') }] : []),
  ];
  const navClass = ({ isActive }: { isActive: boolean }) =>
    `rounded-full px-3 py-1.5 hover:bg-ink/5 ${isActive ? 'text-ink font-medium' : 'text-ink/70'}`;
  return (
    <div className="min-h-screen bg-paper text-ink antialiased">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded-full focus:bg-surface focus:px-4 focus:py-2">{t('Skip to the content')}</a>
      <header className="border-b border-ink/10">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to="/" aria-label={t('Spine, home')} className="inline-flex shrink-0 items-center gap-2 rounded-full py-1 pr-2">
            <LogoMark className="h-7 w-7 shrink-0 text-accent" />
            {/* On a narrow phone the mark alone is the way home (the link is labelled), so the language menu keeps its room. */}
            <span className="font-display text-xl font-medium max-[420px]:sr-only">Spine</span>
          </Link>
          <nav aria-label={t('Pages')} className="hidden items-center gap-1 text-sm lg:flex">
            {links.map(l => <NavLink key={l.to} to={l.to} className={navClass}>{l.label}</NavLink>)}
          </nav>
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
            <LanguageSwitcher />
            <ThemeSwitcher />
            <Link to="/login" className="rounded-full border border-ink/20 px-4 py-1.5 text-sm font-medium hover:bg-ink/5">{t('Sign in')}</Link>
          </div>
        </div>
        <details className="border-t border-ink/10 lg:hidden">
          <summary className="mx-auto max-w-6xl cursor-pointer px-4 py-2.5 text-sm text-ink/70 sm:px-6">{t('Pages')}</summary>
          <nav aria-label={t('Pages')} className="mx-auto flex max-w-6xl flex-col px-2 pb-3 text-sm sm:px-4">
            {links.map(l => <NavLink key={l.to} to={l.to} className={navClass}>{l.label}</NavLink>)}
          </nav>
        </details>
      </header>

      <main id="main">{children}</main>

      <footer className="mt-8 border-t border-ink/10">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm text-ink/65 sm:px-6 md:grid-cols-[1.2fr_1fr_1fr]">
          <div>
            <span className="inline-flex items-center gap-2 text-ink">
              <LogoMark className="h-5 w-5 text-accent" />
              <span className="font-display text-lg">Spine</span>
            </span>
            <p className="mt-3 max-w-xs leading-relaxed">{t('Open-source software, licensed under the AGPL-3.0.')}</p>
          </div>
          <nav aria-label={t('About Spine')} className="flex flex-col gap-2">
            {links.map(l => <Link key={l.to} to={l.to} className="hover:text-ink hover:underline">{l.label}</Link>)}
            <Link to="/encryption" className="hover:text-ink hover:underline">{t('Encryption, in detail')}</Link>
          </nav>
          <nav aria-label={t('The rules')} className="flex flex-col gap-2">
            <Link to="/privacy" className="hover:text-ink hover:underline">{t('Privacy notice')}</Link>
            <Link to="/terms" className="hover:text-ink hover:underline">{t('Terms of use')}</Link>
            <Link to="/purpose" className="hover:text-ink hover:underline">{t('What Spine is for')}</Link>
            <Link to="/trust" className="hover:text-ink hover:underline">{t('How to check this app')}</Link>
            <span className="font-mono text-xs text-ink/50" title={BUILD_COMMIT}>{BUILD_COMMIT.slice(0, 7)}{BUILD_COMMIT.endsWith('-dirty') ? '-dirty' : ''}</span>
          </nav>
        </div>
      </footer>
    </div>
  );
}

/** A page's opening: its title and the sentence that says what it is about. */
export function PageIntro({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-4 pb-6 pt-14 sm:px-6 sm:pt-20">
      <h1 className="max-w-3xl font-display text-[clamp(2.2rem,4.6vw,3.4rem)] font-normal leading-[1.08] tracking-[-0.015em]">{title}</h1>
      {children && <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink/70">{children}</p>}
    </div>
  );
}

/** A section of a page: a heading, and text kept to a readable width. `id` makes it a place a link can point to. */
export function Section({ id, title, lead, children, wide = false }: { id?: string; title: string; lead?: ReactNode; children?: ReactNode; wide?: boolean }) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
        <h2 className="max-w-3xl font-display text-[clamp(1.6rem,3vw,2.2rem)] font-normal leading-tight">{title}</h2>
        {lead && <p className="mt-4 max-w-2xl text-lg leading-relaxed text-ink/70">{lead}</p>}
        {children && <div className={`mt-6 ${wide ? '' : 'max-w-2xl'}`}>{children}</div>}
      </div>
    </section>
  );
}

/** A paragraph of the pages' running text. */
export function P({ children }: { children: ReactNode }) {
  return <p className="mt-4 leading-relaxed text-ink/80 first:mt-0">{children}</p>;
}

/** A link inside running text, in the accent. */
export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to} className="text-accent underline decoration-accent/35 underline-offset-4 hover:decoration-accent">{children}</Link>;
}

/** Signing up or in, and the demo: the app itself with invented records, in this browser only, with no account. */
export function Actions({ options, className = '' }: { options: PublicOptions; className?: string }) {
  const { t, lang } = useI18n();
  const open = options.registration !== 'operator';
  const asks = options.registration === 'approval';
  // Which loop brought the visitor (a shared page, a doctor's recommendation) goes on to the sign-up, where it is counted.
  const ref = new URLSearchParams(window.location.search).get('ref');
  const signUp = ref && /^[a-z]{1,16}$/.test(ref) ? `/register?ref=${ref}` : '/register';
  const { startDemo } = useAuth();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);
  const solid = 'rounded-full bg-accent px-6 py-3 font-medium text-paper hover:bg-accent/90';
  const outline = 'rounded-full border border-ink/25 px-6 py-3 font-medium text-ink hover:bg-ink/5 disabled:opacity-50';
  const tryDemo = async () => {
    setStarting(true); setFailed(false);
    try { await startDemo(lang === 'ro' ? 'ro' : 'en'); navigate('/'); } catch (err) { console.warn('the demo could not start:', (err as Error)?.message); setFailed(true); }
    setStarting(false);
  };
  return (
    <div className={className}>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => void tryDemo()} disabled={starting} className={solid}>{starting ? t('Opening…') : t('Try the demo')}</button>
        {open && <Link to={signUp} className={outline}>{asks ? t('Ask for an account') : t('Create an account')}</Link>}
        {!open && <Link to="/login" className={outline}>{t('Sign in')}</Link>}
      </div>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-ink/60">{t('The demo opens the app with invented records, in this browser only: no account, and nothing is saved.')}</p>
      {failed && <p role="alert" className="mt-2 text-sm text-red-700">{t('The demo could not start in this browser. Try again, or another browser.')}</p>}
    </div>
  );
}
