import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, type EnrolmentOffer } from '../api';
import { buttonClass, Notice } from './AuthCard';
import { useI18n } from '../i18n';
import { vaultState } from '../crypto/vault-state';
import { showCode } from '../crypto/enrolment';

/**
 * Letting another phone or computer open the records without the master password typed there (TR-CRY-05, SECURITY.md M-41). This device
 * shows a one-time code; the other one asks with it; the person sees what asked and approves it here. The code is never sent to the server.
 */
export default function AddDevice() {
  const { t } = useI18n();
  const [code, setCode] = useState<string | null>(null);
  const [qr, setQr] = useState('');
  const [offer, setOffer] = useState<EnrolmentOffer | null>(null);
  const [outcome, setOutcome] = useState<'' | 'approved' | 'refused' | 'expired'>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const live = useRef(false);

  const stop = useCallback(() => { live.current = false; setCode(null); setQr(''); setOffer(null); }, []);

  // While a code is on screen: has a browser asked?
  useEffect(() => {
    if (!code) return;
    live.current = true;
    const timer = setInterval(() => {
      api.enrol.current().then(({ offer: found }) => {
        if (!live.current) return;
        if (found) { setOffer(found); return; }
        // Gone: used (it was approved and collected), taken back, or past its time.
        setOutcome(prev => prev || 'expired');
        stop();
      }).catch(() => undefined);
    }, 2000);
    return () => { clearInterval(timer); live.current = false; };
  }, [code, stop]);

  const start = async () => {
    setBusy(true); setError(''); setOutcome('');
    try {
      const made = await api.enrol.offer();
      setCode(made.code);
      setOffer(null);
      // The address carries the code after the #, which the browser does not send to any server.
      setQr(await QRCode.toString(`${window.location.origin}/pair#${made.code}`, { type: 'svg', margin: 1, width: 176 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not make a code'));
    }
    setBusy(false);
  };
  const decide = async (approve: boolean) => {
    setBusy(true); setError('');
    try {
      await api.enrol.decide(approve);
      setOutcome(approve ? 'approved' : 'refused');
      if (!approve) { await api.enrol.cancel().catch(() => undefined); stop(); }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Something went wrong. Try again.'));
    }
    setBusy(false);
  };
  const cancel = async () => { await api.enrol.cancel().catch(() => undefined); stop(); };

  const open = !!vaultState.session();
  return (
    <section className="bg-white border border-gray-200 rounded-xl p-5 mt-6" aria-labelledby="add-device">
      <h2 id="add-device" className="font-medium text-gray-900 mb-1">{t('Add a device')}</h2>
      <p className="text-xs text-gray-500 mb-4">{t('Open your records on another phone or computer without typing your master password there. This device shows a one-time code, you enter it on the other one, and you approve it here. The records stay encrypted: the code makes a key on each device, and only a sealed copy is kept, for ten minutes.')}</p>
      {outcome === 'approved' && <Notice kind="ok">{t('Approved. The other device is opening your records.')}</Notice>}
      {outcome === 'refused' && <Notice kind="ok">{t('Refused. Nothing was shared with that device.')}</Notice>}
      {outcome === 'expired' && !code && <Notice kind="ok">{t('The code is no longer valid.')}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {code ? (
        <div>
          {offer?.state === 'requested' || offer?.state === 'approved' ? (
            <div role="alert" className="border border-amber-300 bg-amber-50 rounded-lg p-3 mb-3 text-sm text-gray-900">
              <p className="font-medium mb-1">{t('A browser is asking to open your records')}</p>
              <p className="text-xs text-gray-700">{offer.requester_agent || t('Unknown browser')}{offer.requester_country ? ` · ${offer.requester_country}` : ''}</p>
              <p className="text-xs text-gray-700 mt-1 mb-3">{t('Approve it only if you started this yourself, just now, on a device you hold.')}</p>
              {offer.state === 'requested' && (
                <div className="flex gap-2">
                  <button type="button" disabled={busy} onClick={() => void decide(true)} className="bg-brand-600 text-white rounded-full px-4 py-1.5 text-sm font-medium hover:bg-brand-700">{t('Approve')}</button>
                  <button type="button" disabled={busy} onClick={() => void decide(false)} className="border border-gray-300 rounded-full px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-50">{t('Refuse')}</button>
                </div>
              )}
            </div>
          ) : (
            <>
              <p className="text-xs text-gray-500 mb-2">{t('On the other device, open {address}/pair, or choose “Use a code from another device” on the sign-in page, and enter this code. Or scan it with its camera.', { address: window.location.host })}</p>
              <div className="flex flex-wrap items-center gap-4 mb-3">
                <p className="font-mono text-xl tracking-wider text-gray-900 select-all" aria-label={t('Your code')}>{showCode(code)}</p>
                {qr && <div className="w-32 h-32 bg-white p-1 rounded" aria-hidden="true" dangerouslySetInnerHTML={{ __html: qr }} />}
              </div>
              <p className="text-xs text-gray-500 mb-3">{t('Waiting for the other device. The code works once, for ten minutes.')}</p>
            </>
          )}
          <button type="button" onClick={() => void cancel()} className="text-sm text-gray-500 hover:underline">{t('Cancel')}</button>
        </div>
      ) : open ? (
        <button type="button" onClick={start} disabled={busy} className={buttonClass}>{t('Show a code')}</button>
      ) : (
        <p className="text-sm text-gray-500">{t('Unlock your records first, then come back here.')}</p>
      )}
    </section>
  );
}
