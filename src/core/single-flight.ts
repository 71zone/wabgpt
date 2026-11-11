interface Attempt<T> {
  controller: AbortController;
  promise: Promise<T>;
  /** Settles (never rejects) once the work and its cleanup have finished. */
  settled: Promise<void>;
  /** Callers that passed a signal and still want the result. */
  waiters: number;
  /** A caller without a signal joined, so nobody can cancel on its behalf. */
  pinned: boolean;
}

const ignore = (): void => {};

/**
 * One shared, cancellable piece of work.
 * - The work owns an independent AbortController; no caller's signal is handed to it, so no caller listener outlives its call.
 * - Callers without a signal pin the work: it is cancelled only by `cancel()`.
 * - With signals, an abort rejects only that caller while others still wait; once the last interested caller aborts, the work is cancelled and
 *   that caller is rejected with its own reason after the work has drained.
 * - Cancelled work is never joined. A later caller starts new work after the cancelled work has drained, so two runs never overlap.
 * - `drained()` resolves when all started work, including cancelled work still cleaning up, has settled.
 */
export class SingleFlight<T> {
  private current: Attempt<T> | null = null;
  private readonly running = new Set<Promise<void>>();

  join(start: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
    if (caller?.aborted) return Promise.reject(caller.reason);
    const previous = this.current;
    const attempt = previous && !previous.controller.signal.aborted ? previous : this.begin(start, previous?.settled ?? null);
    if (!caller) { attempt.pinned = true; return attempt.promise; }
    attempt.waiters++;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const onAbort = (): void => {
      attempt.waiters--;
      if (attempt.pinned || attempt.waiters > 0) reject(caller.reason);
      else attempt.controller.abort(caller.reason);
    };
    caller.addEventListener('abort', onAbort, { once: true });
    void attempt.promise.then(value => {
      caller.removeEventListener('abort', onAbort);
      if (caller.aborted) reject(caller.reason); else resolve(value);
    }, (error: unknown) => {
      caller.removeEventListener('abort', onAbort);
      reject(caller.aborted ? caller.reason : error);
    });
    return promise;
  }

  /** Cancels the in-flight work, whoever is waiting for it. */
  cancel(reason: unknown): void { this.current?.controller.abort(reason); }

  async drained(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  private begin(start: (signal: AbortSignal) => Promise<T>, after: Promise<void> | null): Attempt<T> {
    const controller = new AbortController();
    const work = Promise.withResolvers<T>();
    const promise = work.promise.finally(() => { if (this.current === attempt) this.current = null; });
    const settled = promise.then(ignore, ignore);
    const attempt: Attempt<T> = { controller, promise, settled, waiters: 0, pinned: false };
    // Fully registered before `start` runs, so a reentrant join from inside `start` joins this attempt instead of beginning a parallel one.
    this.current = attempt;
    this.running.add(settled);
    void settled.then(() => { this.running.delete(settled); });
    // The first await is conditional so that new work starts synchronously when nothing is draining.
    void (async () => {
      if (after) { await after; controller.signal.throwIfAborted(); }
      return await start(controller.signal);
    })().then(work.resolve, work.reject);
    return attempt;
  }
}
