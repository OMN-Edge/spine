import { useI18n } from '../i18n';
import { companyParts, useOperator } from '../operator';

/** Who operates this Spine, as one small muted line: the same on every page, and nothing where the operator has not named themselves. */
export default function CompanyLine({ className = 'text-gray-500' }: { className?: string }) {
  const { t } = useI18n();
  const operator = useOperator();
  if (!operator) return null;
  return <p className={`text-xs leading-relaxed break-words ${className}`}>{companyParts(operator, t('Spine is operated by {name}', { name: operator.name })).join(' · ')}</p>;
}
