/** Whether the store this test run was set up with holds records (`use-records-store`) or is the server's (`use-accounts-store`). */
export const holdsRecordsInThisRun = (): boolean => (globalThis as { __spineStore?: string }).__spineStore !== 'accounts';
