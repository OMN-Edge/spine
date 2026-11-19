/** A call to ANAF, or a document for it, that did not work; `retry` says whether the same call may succeed later (a network failure, a limit, ANAF's own fault) or not (it refused it). */
export class AnafError extends Error {
  constructor(message: string, readonly retry: boolean, readonly status: number | null = null) {
    super(message);
    this.name = 'AnafError';
  }
}
