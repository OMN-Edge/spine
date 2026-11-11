import { useEffect, useState } from 'react';
import { planChanged, useBilling } from '../billing';
import { device } from '../core/client';
import { useI18n } from '../i18n';

/**
 * The one-off allowance for reading an archive (SECURITY.md M-45): where the plan has one and it has pages left, a choice on the Upload page to
 * draw the reading of the uploads that follow from it, so an old archive does not use up the month's. It is the person's to switch on, and off
 * again on its own when the page is left, the core restarts, or the allowance is used up. Shows nothing where there is no allowance.
 */
export default function ImportAllowance() {
  const { t } = useI18n();
  const billing = useBilling();
  const [on, setOn] = useState(false);
  const left = billing?.enabled && billing.ai ? (billing.ai.import.allowance ?? 0) - billing.ai.import.used : 0;
  const has = left > 0;

  useEffect(() => {
    if (!has && on) { setOn(false); void device.setImportMode(false).catch(() => undefined); }
  }, [has, on]);
  // Left behind switched on, the next upload of an ordinary file would draw on it: it is off when the page is left.
  useEffect(() => () => { void device.setImportMode(false).catch(() => undefined); planChanged(); }, []);

  if (!has) return null;
  const choose = (next: boolean) => { setOn(next); void device.setImportMode(next).catch(() => setOn(false)); };
  return (
    <label className="flex items-start gap-2 text-sm text-gray-700 mb-4 rounded-lg border border-gray-200 bg-white p-3">
      <input type="checkbox" checked={on} onChange={e => choose(e.target.checked)} className="mt-1" />
      <span>
        {t('I am importing an archive: read it from my one-off import allowance ({left} pages left).', { left })}
        <span className="block text-xs text-gray-500">{t('It is used once, for good, and what is not used stays for a later archive.')}</span>
      </span>
    </label>
  );
}
