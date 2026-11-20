import { useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/** How long a page may take to put the section a link names on the screen: the records open, and the page's own requests answer, before it exists. */
const WAIT_MS = 4000;

/** The id a fragment names (`#shared` is `shared`, `#a%20b` is `a b`), or null where it names none or is not valid. */
export function hashTarget(hash: string): string | null {
  if (hash.length < 2) return null;
  try { return decodeURIComponent(hash.slice(1)); } catch { return null; }
}

/** Where a page change leaves the screen: at the section its link names, at the top of a new page, and where the browser had it for Back and Forward. */
export type Scroll = { to: 'section'; id: string } | { to: 'top' } | { to: 'stay' };
export function scrollFor(hash: string, navigation: 'PUSH' | 'REPLACE' | 'POP'): Scroll {
  const id = hashTarget(hash);
  if (id) return { to: 'section', id };
  return navigation === 'POP' ? { to: 'stay' } : { to: 'top' };
}

/**
 * Where the screen is after a link. The router changes the page without the browser's own work: it neither jumps to a fragment (`/account#shared`) nor goes back to the top, so
 * a link followed from the middle of one page opened the next at the same height. A section is looked for until it is there or `WAIT_MS` has passed, since it often appears once
 * the data has come; a page that scrolls by itself (the upload page's `#grouping`) is not disturbed, as this only looks for an element with that id.
 */
export function ScrollToHash() {
  const { pathname, hash } = useLocation();
  const navigation = useNavigationType();
  useEffect(() => {
    const plan = scrollFor(hash, navigation);
    if (plan.to === 'stay') return;
    if (plan.to === 'top') { window.scrollTo(0, 0); return; }
    const started = Date.now();
    const look = () => {
      const el = document.getElementById(plan.id);
      if (el) { el.scrollIntoView({ block: 'start' }); return true; }
      return false;
    };
    if (look()) return;
    const timer = setInterval(() => { if (look() || Date.now() - started > WAIT_MS) clearInterval(timer); }, 150);
    return () => clearInterval(timer);
    // The page, or the fragment: a change of the query alone is the same page and leaves the screen where it is.
  }, [pathname, hash]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
