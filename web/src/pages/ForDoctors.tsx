import { Link } from 'react-router-dom';
import { Wordmark } from '../components/Logo';
import { useI18n } from '../i18n';

/**
 * Where a doctor who opened a shared page lands from its footer: what Spine is from their side, and a way to tell their patients about it.
 * The visit is counted as coming from a doctor (`ref=doctors`) if it goes on to a sign-up, a count a day on the server and never who.
 */
export default function ForDoctors() {
  const { t } = useI18n();
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
        <Link to="/" aria-label={t('Spine, home')} className="inline-block mb-6"><Wordmark /></Link>
        <article className="bg-white border border-gray-200 rounded-xl p-6 space-y-4 text-sm text-gray-700 leading-relaxed">
          <h1 className="text-xl font-semibold text-gray-900">{t('For doctors')}</h1>
          <p>{t('Your patient shared their records with you through Spine. They chose what you can see and for how long, and you needed no account.')}</p>
          <p>{t('Spine keeps a person’s medical records in one place that only they can open, shows a report in the reader’s language, and lets them share exactly what a doctor needs.')}</p>
          <p>{t('If you would like your patients to bring their records this way, you can point them to Spine.')}</p>
          <p><Link to="/?ref=doctors" className="text-brand-600 hover:underline">{t('Open the Spine front page')}</Link></p>
        </article>
      </div>
    </div>
  );
}
