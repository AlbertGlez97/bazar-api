export interface LimitResult {
  allowed: boolean;
  /** Cuánto falta para que caduque el golpe más viejo (solo si se bloqueó). */
  retryAfterMs: number;
}

/**
 * Límite de ventana deslizante, en memoria. Una sola instancia del API (un contenedor): el
 * conteo se pierde al reiniciar, y eso es aceptable porque los límites son una protección
 * extra (también hay Turnstile y límites por solicitud guardados en la base de datos).
 * Un golpe bloqueado NO se cuenta, así que insistir no alarga el bloqueo.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  hit(key: string, limit: number, windowMs: number, now = Date.now()): LimitResult {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < windowMs);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: Math.max(1, windowMs - (now - recent[0]!)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Borra las claves sin golpes dentro de la ventana, para no crecer sin fin. */
  sweep(now = Date.now(), windowMs = 60 * 60 * 1000): void {
    for (const [key, times] of this.hits) {
      if (times.every((at) => now - at >= windowMs)) this.hits.delete(key);
    }
  }

  size(): number {
    return this.hits.size;
  }
}
