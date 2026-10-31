import { msg } from './i18n';
import type { DetailKind } from 'spine-core/emergency';

/** What each kind of official detail is called on the screens (marked here so the dictionaries carry them). */
export const DETAIL_LABELS: Record<Exclude<DetailKind, 'other'>, string> = {
  national_id: msg('National identification number'),
  insurance_number: msg('Health insurance number'),
  insurer: msg('Health insurer'),
  passport: msg('Passport or ID card number'),
  donor: msg('Organ donor'),
};
