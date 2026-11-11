import { useBilling } from '../billing';
import { useI18n } from '../i18n';

/** What the archive has done for its owner in all, said as things done and never as a count against a limit, inside the plan card; only what is not zero. */
export default function ArchiveProgress() {
  const { t } = useI18n();
  const billing = useBilling();
  if (!billing?.enabled || !billing.plan || !billing.totals) return null;
  const done: Array<{ n: number; text: string }> = [
    { n: billing.totals.pages, text: t('pages read for you so far') },
    { n: billing.totals.messages, text: t('questions answered about your records so far') },
    { n: billing.totals.translated, text: t('pages translated so far') },
  ].filter(d => d.n > 0);
  if (done.length === 0) return null;
  return (
    <ul className="grid grid-cols-2 gap-2 mb-4">
      {done.map(d => (
        <li key={d.text} className="rounded-lg bg-gray-50 px-3 py-2">
          <span className="block text-xl font-light text-gray-900">{d.n.toLocaleString()}</span>
          <span className="block text-xs text-gray-500">{d.text}</span>
        </li>
      ))}
    </ul>
  );
}
