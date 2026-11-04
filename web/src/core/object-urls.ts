/**
 * Addresses of pictures the cores hold, kept so the same picture is not fetched and decoded again: the most recent `keep`, the oldest let go
 * (and its address revoked). A load that fails is not kept, so asking again tries again: a page image that could not be read once (a share
 * whose images were still being sent, a dropped connection) is not left blank until the page is reloaded.
 */
export function objectUrlCache(load: (url: string) => Promise<string>, revoke: (address: string) => void, keep: number) {
  const shown = new Map<string, Promise<string>>();
  return {
    get(url: string): Promise<string> {
      let found = shown.get(url);
      if (found) { shown.delete(url); shown.set(url, found); return found; }
      found = load(url);
      const mine = found;
      found.catch(() => { if (shown.get(url) === mine) shown.delete(url); });
      shown.set(url, found);
      for (const [key, value] of shown) {
        if (shown.size <= keep) break;
        shown.delete(key);
        void value.then(revoke, () => undefined);
      }
      return found;
    },
    clear(): void {
      for (const value of shown.values()) void value.then(revoke, () => undefined);
      shown.clear();
    },
  };
}
