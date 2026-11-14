import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { takeTokenFromUrl } from '../auth';
import AuthCard, { buttonClass, Notice } from '../components/AuthCard';
import { useI18n } from '../i18n';

/**
 * The page a reminder or a trial mail links to: one button that stops those mails for the account the link was made for. The token is in the address's
 * fragment (it never reaches a server's log) and is taken out of the address on arrival; a button, not the arrival, makes the request, so a mail client that
 * opens every link to check it does not unsubscribe anyone.
 */
export default function Unsubscribe() {
  const { t } = useI18n();
  const [token] = useState(() => takeTokenFromUrl());
  const [state, setState] = useState<'ask' | 'done' | 'failed'>(token ? 'ask' : 'failed');
  const [busy, setBusy] = useState(false);

  const stop = async () => {
    setBusy(true);
    try { await api.mail.unsubscribe(token!); setState('done'); } catch { setState('failed'); setBusy(false); }
  };

  return (
    <AuthCard title={t('Stop these emails')} footer={<p><Link to="/" className="text-brand-600">{t('Back to Spine')}</Link></p>}>
      {state === 'ask' && (
        <div className="space-y-3">
          <p className="text-sm text-gray-700">{t('Spine will stop sending you reminders and the summary before a trial ends. Mail about your account, such as sign-in codes, is not affected.')}</p>
          <button disabled={busy} onClick={() => void stop()} className={buttonClass}>{t('Stop the emails')}</button>
        </div>
      )}
      {state === 'done' && <Notice kind="ok">{t('Done. You will not get these emails again.')}</Notice>}
      {state === 'failed' && <Notice kind="error">{t('This link is incomplete.')}</Notice>}
    </AuthCard>
  );
}
