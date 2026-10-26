import type { HttpReply } from '../http.js';
import type { ChatProgress } from '../chat/index.js';
import { logger } from '../logger.js';
import { describeError } from '../failure.js';

/**
 * A question's reply as JSON lines (NDJSON), for the owner's chat and a share recipient's: `step` (what the agent is looking up),
 * `delta` (a piece of the answer), `reset` (what was shown was a lead-in before a tool call), then `done` with the reply or `error`;
 * a `ping` every ten seconds keeps a proxy from taking a slow model for a dead connection, and `X-Accel-Buffering: no` tells nginx to
 * pass each line on. Everything that can be refused is refused before this is called, so a refusal is an ordinary 4xx.
 *
 * `work` returns the final event (or null when the reader went away). The text shown while it is written is a draft: only `done` is
 * trusted. A reader who leaves aborts the model call and the loop.
 */
export type StreamEnd = { type: 'done'; reply: unknown } | { type: 'error'; status: number; error: string };

/** Lines written as they are made and read as they come: a small async queue, the body of a streamed reply. */
class LineStream implements AsyncIterable<Uint8Array> {
  private readonly queue: Uint8Array[] = [];
  private waiting: (() => void) | null = null;
  private done = false;
  destroyed = false;
  writableEnded = false;
  private readonly encoder = new TextEncoder();

  write(text: string): void {
    if (this.destroyed || this.writableEnded) return;
    this.queue.push(this.encoder.encode(text));
    this.wake();
  }
  end(): void { this.writableEnded = true; this.done = true; this.wake(); }
  /** The reader went away. */
  destroy(): void { this.destroyed = true; this.queue.length = 0; this.done = true; this.wake(); }
  private wake(): void { const w = this.waiting; this.waiting = null; w?.(); }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      const next = this.queue.shift();
      if (next) { yield next; continue; }
      if (this.done) return;
      await new Promise<void>(resolve => { this.waiting = resolve; });
    }
  }
}

export function streamReply(reply: HttpReply, work: (progress: ChatProgress) => Promise<StreamEnd | null>, what: string) {
  const out = new LineStream();
  const aborted = new AbortController();
  let finished = false;
  reply.raw.on('close', () => { if (!finished) aborted.abort(); });
  const line = (event: object) => { if (!out.destroyed && !out.writableEnded) out.write(`${JSON.stringify(event)}\n`); };
  const beat = setInterval(() => line({ type: 'ping' }), 10_000);
  void (async () => {
    try {
      const end = await work({
        step: s => line({ type: 'step', ...s }),
        delta: text => line({ type: 'delta', text }),
        reset: () => line({ type: 'reset' }),
        signal: aborted.signal,
      });
      if (end) line(end);
    } catch (err) {
      // A failure's log line carries no medical text.
      logger.warn(`a question could not be ${what}`, { error: describeError(err) });
      line({ type: 'error', status: 502, error: 'could not answer just now' });
    } finally {
      finished = true;
      clearInterval(beat);
      out.end();
    }
  })();
  return reply.header('Cache-Control', 'no-store').header('X-Accel-Buffering', 'no').type('application/x-ndjson; charset=utf-8').send(out);
}
