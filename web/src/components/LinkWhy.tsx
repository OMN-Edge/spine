import type { LinkWhy } from '../api';
import { useI18n } from '../i18n';

/**
 * Why two documents are suggested as connected: the signals the data gave, as names and numbers. Never a sentence a model wrote and
 * never a claim about the care (FR-ORG-07, FR-ORG-08).
 */
export default function LinkWhyLine({ why }: { why: LinkWhy | null | undefined }) {
  const { t } = useI18n();
  if (!why) return null;
  const parts = [
    why.tests && t('same test: {names}', { names: why.tests.join(', ') }),
    why.doctors && t('same doctor: {names}', { names: why.doctors.join(', ') }),
    why.same_provider && t('same provider'),
    why.tags && t('same tags: {names}', { names: why.tags.join(', ') }),
    why.similarity !== undefined && why.similarity >= 0.5 && t('reads alike'),
    why.days_apart !== undefined && t('dates {n} days apart', { n: why.days_apart }),
  ].filter(Boolean);
  return parts.length > 0 ? <span>{parts.join(' · ')}</span> : null;
}
