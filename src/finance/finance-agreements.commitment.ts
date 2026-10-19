/**
 * Pure rules for the amount an agreement may take from a period's potentially
 * available money. Everything is integer minor units (MXN cents).
 *
 * "Committed" is what the live (not voided) agreements of the SAME exact period
 * already distribute. Payments never release it: the available amount comes from
 * recorded sales and expenses, which a payment does not change, so subtracting
 * what was paid would let the same money be agreed a second time.
 */
export interface Commitment {
  availableMinor: number;
  committedMinor: number;
  /** What can still be agreed; never negative. */
  freeMinor: number;
}

export function commitmentOf(
  availableMinor: number,
  committedMinor: number,
): Commitment {
  return {
    availableMinor,
    committedMinor,
    freeMinor: Math.max(0, availableMinor - committedMinor),
  };
}

/** "$10,000.00" (negative amounts as "-$2,000.00"). Integer math: no float rounding. */
export function formatMxn(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}$${whole}.${cents}`;
}

/** The refusal message, in plain Spanish, with the three numbers a person needs. */
export function exceedsMessage(commitment: Commitment, requestedMinor: number) {
  const missingMinor = requestedMinor - commitment.freeMinor;
  return (
    `No alcanza el disponible del período: hay ${formatMxn(commitment.availableMinor)} disponibles, ` +
    `${formatMxn(commitment.committedMinor)} ya comprometidos en otros acuerdos vigentes y quedan ` +
    `${formatMxn(commitment.freeMinor)} libres. Este acuerdo pide ${formatMxn(requestedMinor)}; ` +
    `faltan ${formatMxn(missingMinor)}.`
  );
}
