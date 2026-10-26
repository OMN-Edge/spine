import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { askForPassword } from '../reauth';
import { buttonClass, inputClass, Notice } from './AuthCard';
import { useI18n } from '../i18n';
import { downloadFromDevice } from '../core/client';

type Capabilities = Awaited<ReturnType<typeof api.sourceFiles.capabilities>>;

/**
 * The account's data: every call to a model is visible (which feature sends what, and where), everything can be taken out, and
 * everything can be deleted, here, at once (GDPR Art. 15, 17, 20; the product's "every AI call is visible").
 */
export default function YourData() {
  const { t } = useI18n();
  const { email, setAuthenticated } = useAuth();
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api.sourceFiles.capabilities().then(setCaps).catch(() => undefined); }, []);

  const exportEverything = async () => {
    try {
      const { fresh } = await api.auth.reauthStatus();
      if (!fresh && !(await askForPassword())) return;
    } catch { return; }
    await downloadFromDevice('/api/export', 'spine-export.zip');
  };

  const remove = async () => {
    setError('');
    try { await api.account.remove(confirm); setAuthenticated(false); } catch (err) { setError(err instanceof Error ? err.message : t('Something went wrong. Try again.')); }
  };

  const where = caps ? `${caps.aiReading.provider}${caps.aiReading.endpoint ? ` (${caps.aiReading.endpoint})` : ''}` : '';
  const flows: string[] = caps ? [
    t('Reading a document: the text of each document is sent to the model provider, {where}, to read out its details and summary.', { where }),
    ...(caps.reading.images ? [t('A page with no text, and every photo, is sent as an image to the same provider, because only a model can read it.')] : [t('Pages with no text and photos are not sent anywhere: they are not read, because sending images is switched off on this server.')]),
    ...(caps.features?.translation ? [t('Translating: the details and your notes for a document are sent to the provider when someone asks for another language, yours or a recipient’s.')] : []),
    ...(caps.features?.chat ? [t('Asking your records: your question and the summaries, notes and results of the matching documents are sent to the provider. Never a page image; the text of a few pages only when you ask the assistant to sort an upload.')] : []),
    ...(caps.features?.linking ? [t('Looking for connected documents: the summaries of up to seven documents at a time are sent to the provider.')] : []),
    ...(caps.similarity?.enabled ? [t('Finding documents by meaning: each document’s summary is sent to the embedding provider.')] : []),
  ] : [];

  return (
    <section className="bg-white border border-gray-200 rounded-xl p-5 mt-6" aria-labelledby="your-data">
      <h2 id="your-data" className="font-medium text-gray-900 mb-1">{t('Your data')}</h2>
      <p className="text-xs text-gray-500 mb-4">
        <Link to="/privacy" className="text-blue-600 hover:underline">{t('Privacy notice')}</Link> · <Link to="/terms" className="text-blue-600 hover:underline">{t('Terms of use')}</Link> · <Link to="/purpose" className="text-blue-600 hover:underline">{t('What Spine is for')}</Link>
      </p>

      {flows.length > 0 && (
        <>
          <h3 className="text-sm font-medium text-gray-900 mb-1">{t('Where your records go')}</h3>
          <ul className="list-disc pl-5 space-y-1 text-xs text-gray-600 mb-4">{flows.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </>
      )}

      <h3 className="text-sm font-medium text-gray-900 mb-1">{t('Take everything with you')}</h3>
      <p className="text-xs text-gray-600 mb-2">{t('Every document with what was read from it, in one ZIP that Spine can read back.')}</p>
      <button type="button" onClick={exportEverything} className="text-sm text-blue-600 hover:underline mb-5">{t('Export everything')}</button>

      <h3 className="text-sm font-medium text-gray-900 mb-1">{t('Delete the account')}</h3>
      <p className="text-xs text-gray-600 mb-2">{t('This deletes the account {email}, its records and its files, at once, with the copy of them in the backups. Database backups made earlier keep the account’s row, its wrapped keys and a list of its sealed objects, for a few days. Type your address to confirm.', { email })}</p>
      <input value={confirm} onChange={e => setConfirm(e.target.value)} placeholder={email} aria-label={t('Email')} className={inputClass} />
      {error && <Notice kind="error">{error}</Notice>}
      <button type="button" onClick={remove} disabled={confirm.trim().toLowerCase() !== email.toLowerCase()} className={`${buttonClass} bg-red-700 hover:bg-red-800 disabled:opacity-50`}>{t('Delete my account')}</button>
    </section>
  );
}
