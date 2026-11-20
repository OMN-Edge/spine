import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/** How long a page may take to put the section a link names on the screen: the records open, and the page's own requests answer, before it exists. */
const WAIT_MS = 4000;

/** The id a fragment names (`#shared` is `shared`, `#a%20b` is `a b`), or null where it names none or is not valid. */
export function hashTarget(hash: string): string | null {
  if (hash.length < 2) return null;
  try { return decodeURIComponent(hash.slice(1)); } catch { return null; }
}

/**
 * A link to a section of a page (`/account#shared`) scrolls to it. The router changes the page without the browser's own jump to the fragment, and the section is
 * often not there yet when the page is (it appears once the data has come), so it is looked for until it is or `WAIT_MS` has passed. A page that scrolls by itself
 * (the upload page's `#grouping`) is not disturbed: this only looks for an element with that id.
 */
export function ScrollToHash() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    const id = hashTarget(hash);
    if (!id) return;
    const started = Date.now();
    const look = () => {
      const el = document.getElementById(id);
      if (el) { el.scrollIntoView({ block: 'start' }); return true; }
      return false;
    };
    if (look()) return;
    const timer = setInterval(() => { if (look() || Date.now() - started > WAIT_MS) clearInterval(timer); }, 150);
    return () => clearInterval(timer);
  }, [pathname, hash]);
  return null;
}
