import { describe, expect, it } from 'vitest';
import {
  SHARED_BLOCKED_MESSAGE,
  SHARED_SELF_ONLY_MESSAGE,
  inviteRestriction,
} from './invite-rules.js';

const base = { shared: false, selectedMemberId: 'ana', targetMemberId: 'beto', businessHasPersonalSocio: true };

describe('inviteRestriction: quién puede invitar a quién', () => {
  it('una cuenta personal invita a otros socios sin cuenta, sin más restricción', () => {
    expect(inviteRestriction(base)).toBeNull();
    expect(inviteRestriction({ ...base, businessHasPersonalSocio: false })).toBeNull();
  });

  it('el acceso compartido puede invitar al socio elegido si el negocio aún no tiene cuentas personales', () => {
    expect(inviteRestriction({ ...base, shared: true, targetMemberId: 'ana', businessHasPersonalSocio: false })).toBeNull();
  });

  it('el acceso compartido no puede invitar a otro socio, aunque no haya cuentas personales', () => {
    expect(inviteRestriction({ ...base, shared: true, businessHasPersonalSocio: false })).toEqual({
      code: 'INVITATION_SHARED_SELF_ONLY',
      message: SHARED_SELF_ONLY_MESSAGE,
    });
  });

  it('si ya hay una cuenta personal, el acceso compartido no invita a nadie, ni al socio elegido', () => {
    for (const targetMemberId of ['ana', 'beto'])
      expect(inviteRestriction({ ...base, shared: true, targetMemberId })).toEqual({
        code: 'INVITATION_SHARED_BLOCKED',
        message: SHARED_BLOCKED_MESSAGE,
      });
  });

  it('los mensajes explican por qué y qué hacer, en frases de 20 palabras o menos', () => {
    expect(SHARED_BLOCKED_MESSAGE).toContain('Pídele a un socio con cuenta personal que te invite');
    expect(SHARED_SELF_ONLY_MESSAGE).toContain('solo puedes invitar al socio que elegiste');
    for (const message of [SHARED_BLOCKED_MESSAGE, SHARED_SELF_ONLY_MESSAGE])
      for (const sentence of message.split(/(?<=[.!?])\s+/))
        expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(20);
  });
});
