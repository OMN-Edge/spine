import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import LegalText from '../components/LegalText';
import { Wordmark } from '../components/Logo';
import { useI18n } from '../i18n';

/** The privacy notice, the terms and the intended purpose: public, read before there is an account. */
export default function LegalPage({ doc }: { doc: 'privacy' | 'terms' | 'purpose' }) {
  const { t } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setText(null); setFailed(false);
    api.legal(doc).then(r => setText(r.markdown)).catch(() => setFailed(true));
  }, [doc]);
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
        <Link to="/" aria-label={t('Spine, home')} className="inline-block mb-6"><Wordmark /></Link>
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          {text === null && !failed && <p className="text-gray-400 text-sm">{t('Loading…')}</p>}
          {failed && <p className="text-sm text-red-600">{t('This text could not be loaded.')}</p>}
          {text !== null && <LegalText markdown={text} />}
        </div>
        <nav className="mt-4 flex gap-4 text-xs text-gray-500" aria-label={t('Legal')}>
          <Link to="/privacy" className="hover:underline">{t('Privacy notice')}</Link>
          <Link to="/terms" className="hover:underline">{t('Terms of use')}</Link>
          <Link to="/purpose" className="hover:underline">{t('What Spine is for')}</Link>
          <Link to="/trust" className="hover:underline">{t('How to check this app')}</Link>
        </nav>
      </div>
    </div>
  );
}
