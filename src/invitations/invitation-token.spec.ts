import { describe, expect, it } from 'vitest';
import {
  INVITATION_MAX_NEW_PER_DAY,
  INVITATION_MAX_PER_DAY,
  INVITATION_MIN_GAP_MS,
  INVITATION_TOKEN_PATTERN,
  INVITATION_TTL_MS,
  generateInvitationToken,
  hashInvitationToken,
} from './invitation-token.js';

describe('invitation token', () => {
  it('son 32 bytes aleatorios en base64url (256 bits) que cumplen el patrón del enlace', () => {
    const { token } = generateInvitationToken();
    expect(token).toMatch(INVITATION_TOKEN_PATTERN);
    expect(token).toHaveLength(43);
  });

  it('cada token es distinto', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateInvitationToken().token));
    expect(tokens.size).toBe(200);
  });

  it('solo se guarda el hash sha256 del token, nunca el token', () => {
    const { token, hash } = generateInvitationToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashInvitationToken(token));
    expect(hash).not.toContain(token);
    // Valor conocido de sha256("abc"): el hash es sha256 en hexadecimal de verdad.
    expect(hashInvitationToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('el patrón rechaza lo que no es un token', () => {
    for (const bad of ['', 'abc', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)}/`, ' '.repeat(43)])
      expect(INVITATION_TOKEN_PATTERN.test(bad), bad).toBe(false);
  });

  it('los límites son los acordados: 72 horas, 3 al día y 1 minuto entre envíos', () => {
    expect(INVITATION_TTL_MS).toBe(72 * 60 * 60 * 1000);
    expect(INVITATION_MAX_PER_DAY).toBe(3);
    expect(INVITATION_MIN_GAP_MS).toBe(60_000);
    expect(INVITATION_MAX_NEW_PER_DAY).toBe(10);
  });
});
