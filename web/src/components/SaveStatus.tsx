import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { device, SAVE_STATE_CHANGED } from '../core/client';

/**
 * Says so when what the person did is not in the vault yet. The records live on this device and are sent to the vault as they change; when
 * a save fails (no connection, the server down) the core keeps trying and the records stay marked as changed, but nobody should work on
 * believing they are kept. While anything is unsaved the browser also asks before the page is left, because leaving drops it.
 */
export default function SaveStatus() {
  const { t } = useI18n();
  const [state, setState] = useState(device.saveState);
  const [trying, setTrying] = useState(false);
  useEffect(() => {
    const on = () => setState(device.saveState);
    window.addEventListener(SAVE_STATE_CHANGED, on);
    return () => window.removeEventListener(SAVE_STATE_CHANGED, on);
  }, []);
  useEffect(() => {
    if (!state.unsaved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state.unsaved]);
  if (!state.error) return null;
  const retry = async () => { setTrying(true); try { await device.save(); } catch { /* the state says it again */ } finally { setTrying(false); } };
  return (
    <div role="alert" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <p>{t('Your latest changes are not saved yet. Spine keeps trying, so keep this page open.')}</p>
      <div className="mt-3">
        <button type="button" disabled={trying} onClick={() => void retry()} className="rounded-lg bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700 disabled:opacity-60">{t('Try again')}</button>
      </div>
    </div>
  );
}
