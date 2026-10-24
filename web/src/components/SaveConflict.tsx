import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { SAVE_CONFLICT, downloadFromDevice } from '../core/client';

/**
 * Two devices saved over one another: the one that lost has stopped saving (it would only pile up objects nothing can use). Its changes
 * since are still here, so they can be taken out as an export before the page is reloaded to carry on from the other device's records.
 */
export default function SaveConflict() {
  const { t } = useI18n();
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    const on = () => setConflict(true);
    window.addEventListener(SAVE_CONFLICT, on);
    return () => window.removeEventListener(SAVE_CONFLICT, on);
  }, []);
  if (!conflict) return null;
  return (
    <div role="alert" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-medium">{t('Another device saved changes first')}</p>
      <p className="mt-1">{t('Changes made here since then are not saved. Download them now, then reload to carry on from the other device’s records.')}</p>
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={() => void downloadFromDevice('/api/export', 'spine-export.zip').catch(() => undefined)} className="rounded-lg bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700">{t('Download what is on this device')}</button>
        <button type="button" onClick={() => window.location.reload()} className="rounded-lg border border-amber-400 px-3 py-1.5 font-medium hover:bg-amber-100">{t('Reload')}</button>
      </div>
    </div>
  );
}
