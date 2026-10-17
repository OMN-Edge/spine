import { useEffect, useState } from 'react';
import type { ModelChoice } from '../api';
import { loadModels } from './aiTarget';
import { useI18n } from '../i18n';

/**
 * The models a reading can be run with, as a list to pick from. Nothing is shown when the operator offers
 * only one. `value` is undefined for the default, so the server uses whatever uploads use.
 */
export function useModels(): ModelChoice[] {
  const [models, setModels] = useState<ModelChoice[]>([]);
  useEffect(() => { loadModels().then(setModels); }, []);
  return models;
}

export default function ModelPicker({
  models, value, onChange, disabled = false,
}: {
  models: ModelChoice[];
  value: string | undefined;
  onChange: (model: string | undefined) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  if (models.length < 2) return null;
  const chosen = value ?? models.find(m => m.default)?.id ?? models[0].id;
  const endpoint = models.find(m => m.id === chosen)?.endpoint;
  return (
    <label className="block text-xs text-gray-700 mt-2">
      {t('Model')}
      <select
        value={chosen} disabled={disabled}
        onChange={e => onChange(models.find(m => m.id === e.target.value)?.default ? undefined : e.target.value)}
        className="ml-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs"
      >
        {models.map(m => <option key={m.id} value={m.id}>{m.label}{m.default ? ` (${t('default')})` : ''}</option>)}
      </select>
      {endpoint && <span className="block mt-1 text-[11px] text-gray-500">{t('Runs at {endpoint}', { endpoint })}</span>}
    </label>
  );
}
