import { Injectable, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { clientIp, hasTrustedIpHeader } from './client-ip.js';
import { SlidingWindowLimiter } from './rate-limiter.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Every number of the registration flow, in ONE place (documented in doc/reglas-de-negocio.md). */
export const REGISTRATION_RULES = {
  /** Solicitudes (POST /business-registration) por hora por IP. */
  createPerIpPerHour: 5,
  /** Correos de verificación que se mandan por hora a un mismo correo. */
  verificationEmailsPerCorreoPerHour: 3,
  /** Verificaciones (POST /verify-email) por hora por IP. */
  verifyPerIpPerHour: 10,
  /** Reenvíos (POST /resend) por hora por IP. */
  resendPerIpPerHour: 10,
  windowMs: HOUR,
  /** Espera mínima entre dos correos de verificación de la misma solicitud. */
  resendWaitMs: MINUTE,
  /** Correos de verificación por solicitud, contando el primero. */
  maxVerificationEmailsPerRequest: 3,
  /** El enlace de verificación vence a las 48 horas. */
  verificationTtlMs: 48 * HOUR,
  /** El enlace de aprobar/rechazar vence a los 30 días de confirmar el correo. */
  approvalTtlMs: 30 * DAY,
  /** Limpieza: sin confirmar el correo, 7 días; rechazadas o vencidas, 30 días. */
  unconfirmedRetentionMs: 7 * DAY,
  rejectedOrExpiredRetentionMs: 30 * DAY,
} as const;

/**
 * Los contadores de intentos del registro (en memoria, una instancia del API). Por IP: lo
 * cuenta el middleware ANTES de validar nada. Por correo: lo cuenta el servicio justo antes
 * de mandar un correo de verificación.
 */
@Injectable()
export class RegistrationLimits {
  private readonly limiter = new SlidingWindowLimiter();
  private hits = 0;

  private sweepSometimes(): void {
    this.hits += 1;
    if (this.hits % 200 === 0) this.limiter.sweep(Date.now(), REGISTRATION_RULES.windowMs);
  }

  /** `true` si esta IP aún puede intentar en esa cubeta (y cuenta el intento). */
  hitIp(bucket: string, ip: string, limit: number) {
    this.sweepSometimes();
    return this.limiter.hit(`ip:${bucket}:${ip}`, limit, REGISTRATION_RULES.windowMs);
  }

  /** `true` si a este correo aún se le pueden mandar más correos de verificación esta hora. */
  allowVerificationEmail(correo: string): boolean {
    this.sweepSometimes();
    return this.limiter.hit(
      `mail:${correo}`,
      REGISTRATION_RULES.verificationEmailsPerCorreoPerHour,
      REGISTRATION_RULES.windowMs,
    ).allowed;
  }
}

/**
 * Middleware (no guard: las rutas públicas no llevan guards) que limita por IP cada ruta del
 * registro. Responde 429 con Retry-After. Corre antes que la validación, así que también
 * cuentan las solicitudes mal formadas.
 */
const ipLogger = new Logger('RegistrationLimits');

export function ipRateLimit(limits: RegistrationLimits, bucket: string, limit: number) {
  let warnedMissingHeader = false;
  return (req: Request, res: Response, next: NextFunction): void => {
    // Behind the Cloudflare tunnel every connection comes from the tunnel: without
    // CF-Connecting-IP all visitors would share ONE bucket. Say so once, never the IP.
    if (!warnedMissingHeader && process.env.NODE_ENV === 'production' && !hasTrustedIpHeader(req)) {
      warnedMissingHeader = true;
      ipLogger.warn(
        'CF-Connecting-IP is missing on a registration request: all visitors share one rate-limit bucket. Check how requests reach the API (CLIENT_IP_HEADER).',
      );
    }
    const result = limits.hitIp(bucket, clientIp(req), limit);
    if (result.allowed) {
      next();
      return;
    }
    res
      .status(429)
      .set('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))))
      .json({
        statusCode: 429,
        code: 'rate_limited',
        message: 'Hiciste demasiados intentos. Espera un rato y vuelve a intentar.',
      });
  };
}
