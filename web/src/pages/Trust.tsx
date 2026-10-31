import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Wordmark } from '../components/Logo';
import { useI18n } from '../i18n';
import { BUILD_COMMIT, BUILD_VERSION } from '../build-info';

const External = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">{children}</a>
);

/**
 * How anyone can check that the app they are running is the published code (docs/verify-build.md, SECURITY.md M-40), for a reader who is not technical.
 * It lives in the app and not in docs/legal/ on purpose: its words are part of the build `hashes.txt` lists, not text an operator can edit.
 * It claims nothing about itself: a page cannot prove its own site honest, and says so. /source, /docs and /security are nginx redirects to the repository.
 */
export default function Trust() {
  const { t, tx } = useI18n();
  const [priv, setPriv] = useState(false);
  useEffect(() => { api.auth.options().then(o => setPriv(o.instance === 'private')).catch(() => {}); }, []);
  const known = /^[0-9a-f]{40}(-dirty)?$/.test(BUILD_COMMIT);
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
        <Link to="/" aria-label={t('Spine, home')} className="inline-block mb-6"><Wordmark /></Link>
        <article className="bg-white border border-gray-200 rounded-xl p-6 space-y-4 text-sm text-gray-700 leading-relaxed">
          <h1 className="text-xl font-semibold text-gray-900">{t('How to check this app')}</h1>
          <p>{t('Spine runs in your browser, and your records are encrypted there before the server keeps anything. So the question that matters is whether the app your browser received is the published, open-source one. This page explains how anyone can check.')}</p>

          {priv && <p>{t('This is a private deployment: its administrator decides who gets an account. The check below is about the code it runs, which is the same published code.')}</p>}

          <h2 className="text-base font-semibold text-gray-900 pt-2">{t('What you are running')}</h2>
          {known ? (
            <>
              <p>{tx('This copy of the app is version {version}, built from the published code at commit {commit}.', { version: <strong>{BUILD_VERSION}</strong>, commit: <code className="break-all rounded bg-gray-100 px-1 py-0.5 text-xs">{BUILD_COMMIT}</code> })}</p>
              {BUILD_COMMIT.endsWith('-dirty') && <p>{t('It also includes changes that are not published, so it is not a release.')}</p>}
            </>
          ) : (
            <p>{t('This copy does not say which published version it was built from, so there is nothing to compare it with.')}</p>
          )}

          <h2 className="text-base font-semibold text-gray-900 pt-2">{t('Three ways to check')}</h2>
          <ul className="list-disc pl-5 space-y-2">
            <li><strong>{t('Read it.')}</strong> {tx('All of the code is public. {link}', { link: <External href="/source">{t('Open the code')}</External> })}</li>
            <li><strong>{t('Ask someone technical to compare.')}</strong> {tx('They build the code at the commit above and compare their files with the ones this site serves. If every file matches, this site is serving exactly that code. {link}', { link: <External href="/docs">{t('How to do it')}</External> })}</li>
            <li><strong>{t('For official releases,')}</strong> {t('GitHub keeps a signed record that the files were built from the published code by its own automated process, not by the person who runs this site.')}</li>
          </ul>

          <h2 className="text-base font-semibold text-gray-900 pt-2">{t('What a check cannot promise')}</h2>
          <ul className="list-disc pl-5 space-y-2">
            <li>{t('This page cannot prove that the site is honest. A site that wanted to cheat could show this same text. The check has to come from outside, from you or someone you trust.')}</li>
            <li>{t('A check covers what the checker was sent. If a site sent different code to one person only, only that person’s own check would see it.')}</li>
            <li>{tx('What the server can and cannot see is in the {link}.', { link: <Link to="/privacy" className="text-brand-600 hover:underline">{t('privacy notice')}</Link> })}</li>
          </ul>

          <p>{tx('Found something wrong? Read how to {link}.', { link: <External href="/security">{t('report it')}</External> })}</p>
        </article>
        <nav className="mt-4 flex gap-4 text-xs text-gray-500" aria-label={t('Legal')}>
          <Link to="/privacy" className="hover:underline">{t('Privacy notice')}</Link>
          <Link to="/terms" className="hover:underline">{t('Terms of use')}</Link>
          <Link to="/purpose" className="hover:underline">{t('What Spine is for')}</Link>
        </nav>
      </div>
    </div>
  );
}
