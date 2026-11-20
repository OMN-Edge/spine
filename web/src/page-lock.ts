/**
 * Holds the page still behind a panel that covers it (the chat, the phone's menu): the body is fixed where it is scrolled to, so a drag on the panel cannot move the page and a phone's
 * browser has nothing to scroll to bring a box into view, and the page is put back exactly when the panel goes. (`overflow: hidden` was not enough: the browser scrolled anyway.)
 * Returns the function that lets go.
 */
export function lockPage(): () => void {
  const style = document.body.style;
  const was = { position: style.position, top: style.top, left: style.left, right: style.right, width: style.width };
  const scrolled = window.scrollY;
  Object.assign(style, { position: 'fixed', top: `-${scrolled}px`, left: '0', right: '0', width: '100%' });
  return () => {
    Object.assign(style, was);
    window.scrollTo(0, scrolled);
  };
}
