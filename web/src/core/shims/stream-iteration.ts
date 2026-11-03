/**
 * Lets a `ReadableStream` be read with `for await`, where the browser does not (Safari has no `Symbol.asyncIterator` on it). PDF.js reads a
 * page's text that way (`getTextContent`), and some images, so in Safari every PDF failed before its first model call, with "undefined is
 * not a function (near '...r of t...')" (Nov 3). The stream's own reader does the same work. As the standard says, leaving the loop early
 * cancels the stream unless `preventCancel` is asked for; a loop that reads to the end only lets go of the reader.
 */
export function addStreamIteration(streams: { prototype: ReadableStream } | undefined): void {
  const proto = streams?.prototype as (ReadableStream & { [Symbol.asyncIterator]?: unknown }) | undefined;
  if (!proto || typeof proto[Symbol.asyncIterator] === 'function') return;
  async function* values<T>(this: ReadableStream<T>, options?: { preventCancel?: boolean }): AsyncGenerator<T, void, undefined> {
    const reader = this.getReader();
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { finished = true; return; }
        yield value;
      }
    } finally {
      if (!finished && !options?.preventCancel) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  for (const key of ['values', Symbol.asyncIterator] as const) Object.defineProperty(proto, key, { value: values, configurable: true, writable: true });
}
