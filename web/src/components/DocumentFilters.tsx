import { useEffect, useState } from 'react';
import { api, type Episode } from '../api';
import { useI18n } from '../i18n';
import { Combobox } from './Combobox';
import { episodeName } from './episode';

/**
 * The filters beyond type and dates (FR-ORG-03): the facility a document came from, the specialty of a doctor named on it, and the
 * episode it belongs to. Each is a list of what the archive really has, so every choice finds something.
 */
export default function DocumentFilters({ value, onChange, className, wrapperClassName = 'relative w-44' }: {
  value: Record<string, string>;
  onChange: (key: 'provider' | 'specialty' | 'episode', v: string) => void;
  className?: string;
  wrapperClassName?: string;
}) {
  const { t } = useI18n();
  const [providers, setProviders] = useState<string[]>([]);
  const [specialties, setSpecialties] = useState<string[]>([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);

  useEffect(() => {
    api.providers.list().then(list => setProviders(list.map(p => p.name))).catch(() => undefined);
    api.doctors.list()
      .then(list => setSpecialties([...new Set(list.map(d => d.specialty?.trim()).filter((s): s is string => !!s))].sort((a, b) => a.localeCompare(b))))
      .catch(() => undefined);
    api.episodes.list('confirmed').then(setEpisodes).catch(() => undefined);
  }, []);

  const pick = (label: string, key: 'provider' | 'specialty' | 'episode', all: string, options: Array<{ value: string; label: string }>) =>
    options.length === 0 ? null : (
      <Combobox
        key={key} ariaLabel={label} wrapperClassName={wrapperClassName} className={className} value={value[key] ?? ''}
        onChange={v => onChange(key, v)}
        options={[{ value: '', label: all }, ...options]}
      />
    );

  return (
    <>
      {pick(t('Facility'), 'provider', t('Any facility'), providers.map(name => ({ value: name, label: name })))}
      {pick(t('Specialty'), 'specialty', t('Any specialty'), specialties.map(name => ({ value: name, label: name })))}
      {pick(t('Episode'), 'episode', t('Any episode'), episodes.map(e => ({ value: e.id, label: episodeName(e, t) })))}
    </>
  );
}
