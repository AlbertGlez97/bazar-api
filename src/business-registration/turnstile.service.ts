import { Injectable, Logger } from '@nestjs/common';

export const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const MAX_TOKEN_LENGTH = 2048;
const VERIFY_TIMEOUT_MS = 5_000;

/**
 * - `ok`: Cloudflare confirmó el token (o el modo de desarrollo explícito lo aceptó).
 * - `invalid`: token vacío, falso, usado o vencido: la persona debe repetir el desafío.
 * - `unavailable`: no se pudo verificar (sin clave, Cloudflare caído, clave mala): 503 amable.
 */
export type TurnstileResult = 'ok' | 'invalid' | 'unavailable';

/** Errores de Cloudflare que son culpa de la configuración, no de la persona. */
const CONFIG_ERRORS = new Set([
  'missing-input-secret',
  'invalid-input-secret',
  'bad-request',
  'internal-error',
]);

/**
 * Verifica en el servidor el token de Cloudflare Turnstile (siteverify). El token es de un
 * solo uso y caduca: Cloudflare lo rechaza si ya se usó. La clave secreta sale de
 * TURNSTILE_SECRET_KEY; nunca se escribe en logs ni en el repositorio.
 *
 * Sin clave: en producción rechaza todo (y lo avisa en el log); fuera de producción solo
 * se salta con TURNSTILE_DEV_BYPASS=true, un modo explícito. En producción ese modo no existe.
 */
@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);

  async verify(token: string, ip: string): Promise<TurnstileResult> {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      return 'invalid';
    }
    const secret = process.env.TURNSTILE_SECRET_KEY;
    if (!secret) {
      if (
        process.env.NODE_ENV !== 'production' &&
        process.env.TURNSTILE_DEV_BYPASS === 'true'
      ) {
        this.logger.warn(
          'TURNSTILE_DEV_BYPASS=true: Turnstile NO se está verificando (solo desarrollo y pruebas).',
        );
        return 'ok';
      }
      this.logger.error(
        'TURNSTILE_SECRET_KEY no está configurada: se rechazan las solicitudes de registro.',
      );
      return 'unavailable';
    }

    try {
      const body = new URLSearchParams({ secret, response: token });
      if (ip && ip !== 'unknown') body.set('remoteip', ip);
      const response = await fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`Turnstile siteverify respondió HTTP ${response.status}.`);
        return 'unavailable';
      }
      const result = (await response.json()) as {
        success?: boolean;
        'error-codes'?: string[];
      };
      if (result.success === true) return 'ok';
      const codes = result['error-codes'] ?? [];
      if (codes.some((code) => CONFIG_ERRORS.has(code))) {
        this.logger.error(
          `Turnstile rechazó la configuración del servidor (${codes.join(', ')}).`,
        );
        return 'unavailable';
      }
      return 'invalid';
    } catch (error) {
      this.logger.warn(
        `No se pudo verificar Turnstile: ${error instanceof Error ? error.name : 'error'}.`,
      );
      return 'unavailable';
    }
  }
}
