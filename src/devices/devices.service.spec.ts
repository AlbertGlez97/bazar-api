import { describe, expect, it } from 'vitest';
import { CREDENTIALS_EMAIL_TIMEOUT_MS } from '../email/email.service.js';
import {
  ACTIVATION_CODE_USED_MESSAGE,
  DEVICE_REVOKED_MESSAGE,
  DEVICE_TRANSACTION_OPTIONS,
} from './devices.service.js';

describe('DevicesService constants', () => {
  it('keeps the transaction timeout well above the email deadline', () => {
    // The activation email is sent from INSIDE the transaction (so a failed
    // send rolls the device back). The email must fail first, in a controlled
    // way, instead of the transaction expiring under a pending call: same
    // 5 s margin the business approval keeps.
    expect(DEVICE_TRANSACTION_OPTIONS.timeout).toBeGreaterThanOrEqual(
      CREDENTIALS_EMAIL_TIMEOUT_MS + 5_000,
    );
  });

  it('words a used identifier and a revoked device differently', () => {
    expect(ACTIVATION_CODE_USED_MESSAGE).toBe(
      'Este identificador ya fue usado. Pide a un socio que te genere uno nuevo.',
    );
    expect(DEVICE_REVOKED_MESSAGE).toMatch(/revocado/i);
    expect(DEVICE_REVOKED_MESSAGE).not.toBe(ACTIVATION_CODE_USED_MESSAGE);
  });
});
