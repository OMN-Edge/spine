/**
 * What kind of failure a stored message describes, so the page can say it in plain words (and translated) instead of showing the message.
 * The message stays for the log and the operator; a person is told what to do.
 */
export type FailureKind = 'reading_off' | 'limit' | 'service' | 'other';

export function failureKind(message: string | null | undefined): FailureKind {
  const text = message ?? '';
  if (/image reading is switched off/i.test(text)) return 'reading_off';
  if (/daily limit|model calls is reached|answered 429/i.test(text)) return 'limit';
  if (/model service|answered 5\d\d|answered 40[13]|no pass|failed to fetch|network|timed out|aborted/i.test(text)) return 'service';
  return 'other';
}
