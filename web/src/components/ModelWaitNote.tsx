import type { ModelWaiting } from '../api';
import { useI18n } from '../i18n';

/**
 * Work the reading service could not be asked for (a daily limit, an outage): nothing is lost and nothing is for the owner to do, since
 * it is done by itself at `retry_at` (core/src/ingestion/model-wait.ts). Said, so a document is not taken for an empty one.
 */
export default function ModelWaitNote({ waiting, className = '' }: { waiting: ModelWaiting; className?: string }) {
  const { t } = useI18n();
  const time = new Date(waiting.retry_at).toLocaleString();
  return (
    <p role="status" className={`rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900 ${className}`}>
      {waiting.reason === 'limit'
        ? t('The limit on reading for today has been reached. This is read by itself when it starts again, at {time}.', { time })
        : t('The reading service could not be reached. This is tried again by itself at {time}.', { time })}
    </p>
  );
}
