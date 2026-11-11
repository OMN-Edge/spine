/**
 * What a device does for the follow-up reminders it holds (SECURITY.md **M-53**): tell the server which are due when, so it can mail the person on
 * the day. Only a date for each, under a random id: the words of a reminder stay in the records, which the server cannot read. The device
 * registers it; a process that does not (the server's tests, a reader of a share) has none, and then no date is sent anywhere.
 */
export interface ReminderHost {
  /** Replaces what the server holds for these records with these dates: a reminder not named is gone from the server, which is how a change, a deletion and a document that went all reach it. */
  replace(items: Array<{ id: string; dueOn: string }>): Promise<void>;
}

let host: ReminderHost | null = null;

export function useReminderHost(next: ReminderHost | null): void { host = next; }
export const reminderHost = (): ReminderHost | null => host;
