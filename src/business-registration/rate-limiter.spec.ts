import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from './rate-limiter.js';

const HOUR = 60 * 60 * 1000;

describe('SlidingWindowLimiter', () => {
  it('deja pasar hasta el límite y bloquea el siguiente', () => {
    const limiter = new SlidingWindowLimiter();
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.hit('ip:1', 5, HOUR, 1_000 + i).allowed).toBe(true);
    }

    const blocked = limiter.hit('ip:1', 5, HOUR, 2_000);

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('cada clave lleva su propia cuenta', () => {
    const limiter = new SlidingWindowLimiter();
    for (let i = 0; i < 5; i += 1) limiter.hit('ip:1', 5, HOUR, 1_000);

    expect(limiter.hit('ip:1', 5, HOUR, 1_001).allowed).toBe(false);
    expect(limiter.hit('ip:2', 5, HOUR, 1_001).allowed).toBe(true);
  });

  it('el mismo nombre en cubetas distintas no se mezcla', () => {
    const limiter = new SlidingWindowLimiter();
    for (let i = 0; i < 3; i += 1) limiter.hit('mail:a', 3, HOUR, 1_000);

    expect(limiter.hit('ip:a', 3, HOUR, 1_001).allowed).toBe(true);
  });

  it('al pasar la ventana vuelve a dejar pasar', () => {
    const limiter = new SlidingWindowLimiter();
    for (let i = 0; i < 3; i += 1) limiter.hit('k', 3, HOUR, 1_000);
    expect(limiter.hit('k', 3, HOUR, 1_000 + HOUR - 1).allowed).toBe(false);

    expect(limiter.hit('k', 3, HOUR, 1_000 + HOUR + 1).allowed).toBe(true);
  });

  it('retryAfterMs dice cuánto falta para que caduque el golpe más viejo', () => {
    const limiter = new SlidingWindowLimiter();
    limiter.hit('k', 1, HOUR, 10_000);

    const blocked = limiter.hit('k', 1, HOUR, 10_000 + 1_000);

    expect(blocked.retryAfterMs).toBe(HOUR - 1_000);
  });

  it('un golpe bloqueado NO alarga el bloqueo', () => {
    const limiter = new SlidingWindowLimiter();
    limiter.hit('k', 1, HOUR, 0);
    for (let i = 0; i < 10; i += 1) limiter.hit('k', 1, HOUR, 1_000);

    expect(limiter.hit('k', 1, HOUR, HOUR + 1).allowed).toBe(true);
  });

  it('limpia las claves vencidas para no crecer sin fin', () => {
    const limiter = new SlidingWindowLimiter();
    for (let i = 0; i < 100; i += 1) limiter.hit(`k${i}`, 1, HOUR, 0);
    expect(limiter.size()).toBe(100);

    limiter.hit('nueva', 1, HOUR, 2 * HOUR);
    limiter.sweep(2 * HOUR, HOUR);

    expect(limiter.size()).toBe(1);
  });
});
