import { useBilling } from '../billing';
import { useI18n } from '../i18n';

/** What the archive has done for its owner, said as things done and never as a count against a limit; shows only what is not zero, and nothing on an instance with no plans. */
export default function ArchiveProgress() {
  const { t } = useI18n();
  const billing = useBilling();
  if (!billing?.enabled || !billing.plan) return null;
  const { ai, links } = billing;
  const done: Array<{ n: number; text: string }> = [
    { n: ai?.reading.used ?? 0, text: t('pages read for you this month') },
    { n: ai?.chat.used ?? 0, text: t('questions answered about your records this month') },
    { n: ai?.translation.used ?? 0, text: t('pages translated this month') },
    { n: links?.views.used ?? 0, text: t('times a share link was opened this month') },
  ].filter(d => d.n > 0);
  return (
    <section className="bg-white border border-gray-200 rounded-xl p-5 mt-6">
      <h3 className="font-medium text-gray-900 mb-1">{t('Your archive at work')}</h3>
      {done.length === 0
        ? <p className="text-sm text-gray-500">{t('Add a document and it shows here what Spine has done with it.')}</p>
        : <ul className="grid grid-cols-2 gap-3 mt-3">{done.map(d => (
            <li key={d.text} className="rounded-lg bg-gray-50 p-3">
              <span className="block text-2xl font-light text-gray-900">{d.n}</span>
              <span className="block text-xs text-gray-500">{d.text}</span>
            </li>
          ))}</ul>}
    </section>
  );
}
