/** A promise did not settle within its time budget. */
export class TimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs} ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Rejects with a {@link TimeoutError} when `work` has not settled after
 * `timeoutMs`. The timer is always cleared once either side settles, so it
 * never keeps the process (or a test run) alive.
 *
 * This only stops WAITING: it cannot cancel `work`. If the underlying
 * operation (e.g. an HTTP request with no abort support) is already on the
 * wire it may still complete after the timeout. A late failure of `work` is
 * swallowed so it does not surface as an unhandled rejection.
 */
export function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(label, timeoutMs)),
      timeoutMs,
    );
  });
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
