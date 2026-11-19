import { describe, expect, it, vi } from 'vitest';
import { canShare, copyLink, shareLink } from './share-link';

/** The invite link's Copy and Share buttons (T-08). */
describe('copying a link', () => {
  it('puts exactly the link on the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    expect(await copyLink('https://spine.example/register?ref=invite&by=abc', { clipboard: { writeText } })).toBe(true);
    expect(writeText).toHaveBeenCalledWith('https://spine.example/register?ref=invite&by=abc');
  });

  it('says no where there is no clipboard or it refuses, instead of failing', async () => {
    expect(await copyLink('https://x.example', {})).toBe(false);
    expect(await copyLink('https://x.example', { clipboard: { writeText: async () => { throw new Error('denied'); } } })).toBe(false);
  });
});

describe('sharing a link', () => {
  it('is offered only where the browser can share', () => {
    expect(canShare({})).toBe(false);
    expect(canShare({ share: async () => undefined })).toBe(true);
  });

  it('hands the sheet the link, and a closed sheet is not an error', async () => {
    const share = vi.fn(async () => undefined);
    await shareLink({ url: 'https://x.example', title: 'Spine' }, { share });
    expect(share).toHaveBeenCalledWith({ url: 'https://x.example', title: 'Spine' });
    await expect(shareLink({ url: 'https://x.example' }, { share: async () => { throw new DOMException('closed', 'AbortError'); } })).resolves.toBeUndefined();
  });
});
