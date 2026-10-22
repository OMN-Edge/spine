import { useI18n } from '../i18n';

/** Marks text a model wrote (AI Act Art. 50): a summary, an answer, a translation. The document itself prevails. */
export default function AiLabel({ className = '' }: { className?: string }) {
  const { t } = useI18n();
  return (
    <span
      className={`inline-block align-middle rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide bg-gray-100 text-gray-500 ${className}`}
      title={t('Written by an AI model from the document. It can be wrong: the document prevails.')}
    >
      {t('AI')}
    </span>
  );
}
