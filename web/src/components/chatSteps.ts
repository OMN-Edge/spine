import type { ChatStep } from '../api';

/** What the assistant is doing, in the person's language, for the line above an answer being written. Used by both chats. */
export function stepText(t: (s: string, v?: Record<string, string | number>) => string, step: ChatStep): string {
  const what = step.detail ?? '';
  switch (step.kind) {
    case 'search': return t('Searching for “{what}”', { what });
    case 'open': return t('Reading “{what}”', { what });
    case 'series': return t('Looking at the values of “{what}”', { what });
    case 'tests': return t('Checking which tests you have');
    case 'connections': return t('Following the connections of “{what}”', { what });
    case 'fields': return t('Reading the fields of “{what}”', { what });
    case 'shares': return t('Looking at your share links');
    case 'doctors': return t('Looking at your doctors');
    case 'uploads': return t('Looking at your uploads');
    case 'plan': return t('Reading the regrouping plan');
    case 'library': return t('Looking at your tags and providers');
    case 'propose': return t('Preparing a change for you to confirm');
  }
}

/** The text of an answer still being written: citations are only numbered once the whole reply is in, so none shows half-made. */
export const draftText = (text: string) =>
  text.replace(/\s*\[(?:[DTCS]\d+(?:\.[a-z]+)?[,;\s]*)+\]/g, '').replace(/\s*\[[^\]]*$/, '');
