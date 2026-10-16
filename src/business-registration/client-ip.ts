import { isIP } from 'node:net';
import type { Request } from 'express';

/**
 * Cabecera con la IP real de quien consulta. En producción las peticiones llegan por el
 * túnel de Cloudflare: la conexión TCP viene del túnel (la misma IP para todos), así que la
 * IP buena está en `CF-Connecting-IP`, que Cloudflare pone en cada petición. Se puede
 * cambiar con CLIENT_IP_HEADER. NO se usa X-Forwarded-For: cualquiera puede escribirlo.
 */
const DEFAULT_HEADER = 'cf-connecting-ip';

function stripMapped(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

/**
 * IP del cliente para los límites. Si la cabecera falta o no es UNA IP válida, se usa la
 * dirección de la conexión (desarrollo local). Nunca lanza: sin nada devuelve "unknown".
 */
export function clientIp(req: Pick<Request, 'headers' | 'socket'>): string {
  const name = (process.env.CLIENT_IP_HEADER || DEFAULT_HEADER).toLowerCase();
  const raw = req.headers?.[name];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header === 'string' && isIP(header.trim()) !== 0) {
    return stripMapped(header.trim());
  }
  const socketAddress = req.socket?.remoteAddress;
  return socketAddress ? stripMapped(socketAddress) : 'unknown';
}
