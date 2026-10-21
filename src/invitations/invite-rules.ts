export const SHARED_BLOCKED_MESSAGE =
  'Tu acceso es compartido y ya hay cuentas personales. Pídele a un socio con cuenta personal que te invite.';
export const SHARED_SELF_ONLY_MESSAGE =
  'Con el acceso compartido solo puedes invitar al socio que elegiste en este momento.';

export interface InviteRestriction {
  code: 'INVITATION_SHARED_BLOCKED' | 'INVITATION_SHARED_SELF_ONLY';
  message: string;
}

/**
 * Who may invite whom. A shared login cannot prove which person is using it, so it may only
 * create the FIRST personal account of a business, and only for the socio selected at that
 * moment. Once any socio has a personal account, only personal accounts invite.
 * Returns null when the invitation is allowed.
 */
export function inviteRestriction(input: {
  /** The acting login has no member bound to it. */
  shared: boolean;
  selectedMemberId: string;
  targetMemberId: string;
  /** Some active socio of the business already has a personal (bound) login. */
  businessHasPersonalSocio: boolean;
}): InviteRestriction | null {
  if (!input.shared) return null;
  if (input.businessHasPersonalSocio)
    return { code: 'INVITATION_SHARED_BLOCKED', message: SHARED_BLOCKED_MESSAGE };
  if (input.targetMemberId !== input.selectedMemberId)
    return { code: 'INVITATION_SHARED_SELF_ONLY', message: SHARED_SELF_ONLY_MESSAGE };
  return null;
}
