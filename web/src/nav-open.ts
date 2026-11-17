/**
 * While the phone's menu is open, the floating pills ("Getting started", "Ask") would sit over its last rows, so the page says so on `<body>` and they hide themselves
 * (`[body[data-nav-open]_&]:hidden` in `ChatPanel.tsx`). They come back when the menu closes.
 */
export const NAV_OPEN = 'data-nav-open';

export function setNavOpen(body: Pick<HTMLElement, 'toggleAttribute'>, open: boolean): void {
  body.toggleAttribute(NAV_OPEN, open);
}
