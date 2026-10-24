import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { RECORDS_CHANGED } from '../core/client';

/**
 * Another device saved changes to the same records. They are already merged into this device's records (a row's newest change wins, so
 * nothing either device did is lost), but what is on screen was read before: a reload shows them.
 */
export default function SyncNotice() {
  const { t } = useI18n();
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    const on = () => setChanged(true);
    window.addEventListener(RECORDS_CHANGED, on);
    return () => window.removeEventListener(RECORDS_CHANGED, on);
  }, []);
  if (!changed) return null;
  return (
    <div role="status" className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
      <p className="font-medium">{t('Another device made changes')}</p>
      <p className="mt-1">{t('They are already here. Reload to see them.')}</p>
      <div className="mt-3">
        <button type="button" onClick={() => window.location.reload()} className="rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700">{t('Reload')}</button>
      </div>
    </div>
  );
}
