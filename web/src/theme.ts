export type ThemeChoice = 'auto' | 'light' | 'dark';
type Look = 'light' | 'dark';

declare global {
  interface Window { spineTheme?: { get(): ThemeChoice; set(choice: ThemeChoice): void } }
}

/**
 * The light or dark look. `public/theme.js` (loaded in the page's <head>, so nothing is drawn in the wrong one) keeps the choice in this
 * browser and sets `data-theme` on <html>, which the stylesheet reads (tailwind.config.js). Nothing chosen follows the device.
 */
export const currentLook = (): Look => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

const deviceLook = (): Look => (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/** The other look. Choosing the one the device has goes back to following the device, so there is no third state to find. */
export function toggleLook(): void {
  const next: Look = currentLook() === 'dark' ? 'light' : 'dark';
  window.spineTheme?.set(next === deviceLook() ? 'auto' : next);
}

/** Calls `changed` when the look changes for a reason of its own (the device switched, another tab chose). */
export function watchLook(changed: () => void): () => void {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
