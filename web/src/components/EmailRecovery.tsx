import { useEffect, useState } from 'react';
import { api } from '../api';
import { buttonClass, Notice } from './AuthCard';
import { useI18n } from '../i18n';

/**
 * Whether an emailed link may recover the account (SECURITY.md S-38). On unless the owner turns it off. The server holds the rule and
 * says no when the vault cannot yet be recovered with the kit alone; this only asks and shows the answer.
 */
export default function EmailRecovery() {
  const { t } = useI18n();
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.auth.me().then(me => setOn(me.email_recovery !== false)).catch(() => setOn(true));
  }, []);

  const change = async () => {
    if (on === null) return;
    setError('');
    setBusy(true);
    try {
      setOn((await api.auth.setEmailRecovery(!on)).email_recovery);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not change this setting'));
    } finally {
      setBusy(false);
    }
  };

  if (on === null) return null;
  return (
    <section className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
      <h3 className="font-medium text-gray-900 mb-1">{t('Recovery by email')}</h3>
      <p className="text-sm text-gray-500 mb-3">
        {on
          ? t('If you forget your password, a link sent to your email can reset it. With your recovery kit your records stay as they are.')
          : t('No recovery email is sent. Your password and your recovery kit are the only way back in: without both, your records cannot be recovered.')}
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      <button type="button" onClick={change} disabled={busy} className={`${buttonClass} disabled:opacity-50`}>{on ? t('Turn off recovery by email') : t('Turn on recovery by email')}</button>
    </section>
  );
}
