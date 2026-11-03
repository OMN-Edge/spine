import { describe, expect, it } from 'vitest';
import { addStreamIteration } from './stream-iteration';

/** A ReadableStream as Safari has it: no `for await`. */
function safariStreams() {
  class Bare<T> extends ReadableStream<T> {}
  Object.defineProperty(Bare.prototype, Symbol.asyncIterator, { value: undefined, configurable: true, writable: true });
  Object.defineProperty(Bare.prototype, 'values', { value: undefined, configurable: true, writable: true });
  return Bare;
}
const of = <T>(Streams: ReturnType<typeof safariStreams>, items: T[], onCancel?: () => void) =>
  new Streams<T>({ start(c) { for (const item of items) c.enqueue(item); c.close(); }, cancel: onCancel });

describe('reading a stream with for await, in a browser that cannot', () => {
  it('cannot until it is added, and then reads every chunk, as PDF.js does for a page’s text', async () => {
    const Streams = safariStreams();
    const read = async (stream: ReadableStream<number>) => { const got: number[] = []; for await (const chunk of stream as unknown as AsyncIterable<number>) got.push(chunk); return got; };
    await expect(read(of(Streams, [1, 2, 3]))).rejects.toThrow(TypeError);
    addStreamIteration(Streams);
    const stream = of(Streams, [1, 2, 3]);
    expect(await read(stream)).toEqual([1, 2, 3]);
    expect(stream.locked).toBe(false);
  });

  it('cancels the stream when the loop leaves early, and leaves a browser that can as it is', async () => {
    const Streams = safariStreams();
    addStreamIteration(Streams);
    let cancelled = false;
    for await (const _chunk of of(Streams, [1, 2], () => { cancelled = true; }) as unknown as AsyncIterable<number>) break;
    expect(cancelled).toBe(true);

    const iterator = () => (ReadableStream.prototype as unknown as Record<symbol, unknown>)[Symbol.asyncIterator];
    const own = iterator();
    addStreamIteration(ReadableStream);
    expect(iterator()).toBe(own);
  });
});
