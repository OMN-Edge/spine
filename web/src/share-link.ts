/** What a button that copies or shares a link needs of the browser, so a test can give it one that is not there. */
export interface LinkTools {
  clipboard?: { writeText: (text: string) => Promise<void> };
  share?: (data: { url: string; title?: string; text?: string }) => Promise<void>;
}

/** Puts the link on the clipboard; false where the browser would not (no clipboard, or a refusal), so the page can show the link to be copied by hand. */
export async function copyLink(url: string, tools: LinkTools = navigator): Promise<boolean> {
  if (!tools.clipboard) return false;
  try { await tools.clipboard.writeText(url); return true; } catch { return false; }
}

/** Whether this browser has a sheet to share a link with (a phone's), so "Share" is offered only there. */
export const canShare = (tools: LinkTools = typeof navigator === 'undefined' ? {} : navigator): boolean => typeof tools.share === 'function';

/** Opens the sheet; a person closing it is not a failure. */
export async function shareLink(data: { url: string; title?: string; text?: string }, tools: LinkTools = navigator): Promise<void> {
  if (!tools.share) return;
  try { await tools.share(data); } catch { /* closed without choosing */ }
}
