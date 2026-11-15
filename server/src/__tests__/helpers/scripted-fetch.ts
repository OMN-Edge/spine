export interface Call { url: string; init: RequestInit }

/** A scripted service: each answer is used once, in order, whatever is asked; an `Error` is a request that never got an answer. */
export function scripted(answers: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected call to ${url}`);
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}
