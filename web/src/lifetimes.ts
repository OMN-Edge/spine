import { msg } from './i18n';

/** How long a share link can live (FR-SHR-02): the choices offered, in hours; the server accepts any whole number from 1 to 720. */
export const LIFETIMES: Array<{ hours: number; label: string }> = [
  { hours: 1, label: msg('1 hour') },
  { hours: 6, label: msg('6 hours') },
  { hours: 24, label: msg('1 day') },
  { hours: 72, label: msg('3 days') },
  { hours: 168, label: msg('7 days') },
  { hours: 336, label: msg('14 days') },
  { hours: 720, label: msg('30 days') },
];
