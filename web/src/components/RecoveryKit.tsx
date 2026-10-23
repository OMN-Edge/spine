import { useEffect, useState } from 'react';
import { writeRecoveryKey } from '../crypto/recovery-kit';
import { buttonClass, Notice } from './AuthCard';
import { useI18n } from '../i18n';

/**
 * The recovery kit, shown once (TR-CRY-04). It is the only way back into the records if the master password is lost, and the operator
 * cannot make another: the page says so plainly and does not go on until the person says the kit is somewhere safe.
 */
export default function RecoveryKit({ recoveryKey, email, onDone, busy }: { recoveryKey: Uint8Array; email: string; onDone: () => void; busy?: boolean }) {
  const { t } = useI18n();
  const [kit, setKit] = useState('');
  const [kept, setKept] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => { writeRecoveryKey(recoveryKey).then(setKit); }, [recoveryKey]);

  const sheet = () =>
    [t('Spine recovery kit'), '', `${t('Account')}: ${email}`, '', kit, '', t('Anyone who has this can open your records. Spine cannot make another one or recover your records without it.')].join('\n');

  const download = () => {
    const url = URL.createObjectURL(new Blob([sheet()], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'spine-recovery-kit.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(kit); setCopied(true); } catch { /* the page still shows it */ }
  };

  return (
    <div>
      <p className="text-sm text-gray-700 mb-3">{t('This is your recovery kit. If you forget your password, it is the only way back into your records.')}</p>
      <Notice kind="error">{t('Spine cannot recover your records for you: nobody but you holds a key to them. Without your password and this kit, they are gone.')}</Notice>
      <div className="font-mono text-base tracking-wide bg-gray-50 border border-gray-200 rounded-lg p-3 my-3 break-all select-all" data-testid="recovery-kit">{kit}</div>
      <div className="flex flex-wrap gap-2 mb-4 text-sm">
        <button type="button" onClick={() => window.print()} className="border border-gray-300 rounded-lg px-3 py-1.5 text-gray-700 hover:bg-gray-50">{t('Print')}</button>
        <button type="button" onClick={download} className="border border-gray-300 rounded-lg px-3 py-1.5 text-gray-700 hover:bg-gray-50">{t('Save as a file')}</button>
        <button type="button" onClick={copy} className="border border-gray-300 rounded-lg px-3 py-1.5 text-gray-700 hover:bg-gray-50">{copied ? t('Copied') : t('Copy')}</button>
      </div>
      <label className="flex items-start gap-2 text-sm text-gray-700 mb-3">
        <input type="checkbox" checked={kept} onChange={e => setKept(e.target.checked)} className="mt-1" />
        <span>{t('I have stored my recovery kit somewhere safe, apart from my password.')}</span>
      </label>
      <button type="button" disabled={!kept || busy || !kit} onClick={onDone} className={`${buttonClass} disabled:opacity-50`}>{t('Continue')}</button>
    </div>
  );
}
