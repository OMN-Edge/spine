/**
 * Bounded parallelism for the calls that wait on a model provider or a local program.
 *
 * Reading a page, checking whether two pages belong together and extracting a document
 * are independent of each other, and each mostly waits, so doing several at once is much
 * faster. But providers rate-limit, and a Raspberry Pi runs out of memory and cores, so the
 * number in flight is a setting (`SPINE_LLM_CONCURRENCY`), not "everything at once".
 *
 * Only the waiting is parallel. Anything that writes to the database stays in a plain loop
 * after the results are in: the store shares one connection, and a transaction must not
 * have other work interleave with it.
 */

/** At most `limit` of the calls passed to the returned function run at once; the rest wait their turn. */
export function limiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];

  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active < limit) active += 1;
    else await new Promise<void>(resolve => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the next in line, so the count never overshoots.
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

/**
 * `fn` over every item, at most `limit` at a time, results in the order of the items.
 *
 * After the first failure no further item is started, so a provider outage or an unreadable
 * page does not keep spending calls on the rest, and the first error is the one thrown.
 * Items already in flight are allowed to finish; their results are dropped.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;

  const worker = async () => {
    while (!failure) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return results;
}
