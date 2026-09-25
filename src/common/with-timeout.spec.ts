import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeoutError, withTimeout } from './with-timeout.js';

describe('withTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rejects with a TimeoutError naming the label and the limit', async () => {
    const outcome = withTimeout(new Promise<never>(() => undefined), 8_000, 'Resend email')
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(7_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    const error = await outcome;
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as Error).message).toBe('Resend email timed out after 8000 ms');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves with the value and leaves no timer behind', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 8_000, 'x')).resolves.toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates the original rejection and leaves no timer behind', async () => {
    const boom = new Error('boom');
    await expect(withTimeout(Promise.reject(boom), 8_000, 'x')).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not leave an unhandled rejection when the work fails after the timeout', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let fail!: (reason: Error) => void;
      const late = new Promise<never>((_, reject) => (fail = reject));
      const outcome = withTimeout(late, 100, 'x').catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      expect(await outcome).toBeInstanceOf(TimeoutError);

      fail(new Error('too late'));
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
