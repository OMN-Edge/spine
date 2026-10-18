import { useEffect, useRef } from 'react';

/**
 * A change the chat's Confirm made (a note, a correction, a share link) happens outside the page that shows the thing it
 * changed. The page that holds such data listens, and reads it again.
 */
const EVENT = 'spine:data-changed';

export const announceChange = () => window.dispatchEvent(new Event(EVENT));

export function useOnDataChanged(callback: () => void) {
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    const handler = () => latest.current();
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);
}
