import { canonicalDigest } from '../common/canonical-json.js';
import { currentBusinessDate } from '../common/business-time.js';

export const AGREEMENT_ALGORITHM_VERSION = 1;
export const AGREEMENT_GENERATED_FROM = 'DISTRIBUTION_SIMULATOR';
export const AGREEMENT_NOTICE =
  'Documento generado a partir de una simulación aceptada por los participantes. No es un contrato legal ni registra pagos.';
/** Simulator warnings that only make sense for an unsaved simulation. */
export const SIMULATION_ONLY_WARNING_CODES: readonly string[] = [
  'SIMULATION_ONLY',
  'NOT_A_PAYMENT_OR_OBLIGATION',
];

export interface SimulationShape {
  period: unknown;
  currency: string;
  financialBase: {
    potentiallyAvailableMinor: number;
    requestedAmountMinor: number;
    remainingAvailableMinor: number;
    status: string;
  };
  rule: unknown;
  pools: unknown;
  members: unknown[];
  totals: unknown;
  warnings: { code: string; message: string }[];
  simulationFingerprint: string;
}

export interface AgreementDocumentInput {
  contextId: string;
  id: string;
  folio: string;
  title: string;
  note: string | null;
  replacesAgreement: { id: string; folio: string } | null;
  occurredAt: Date;
  receivedAt: Date;
  createdBy: {
    memberId: string;
    name: string;
    accountId: string;
    deviceId: string;
  };
  simulation: SimulationShape;
}

/**
 * Folio `AC-<year>-<number>`: the number is zero-padded to at least 5 digits
 * and grows naturally beyond 99999.
 */
export function formatFolio(year: number, number: number): string {
  return `AC-${String(year).padStart(4, '0')}-${String(number).padStart(5, '0')}`;
}

/** Folio year: the business-timezone (UTC-6) calendar year of the server instant. */
export function folioYear(receivedAt: Date): number {
  return Number(currentBusinessDate(receivedAt).slice(0, 4));
}

/**
 * The frozen document of record, built ONLY from the server simulation (never
 * from client figures) and hashed from in-memory objects: JSONB reorders keys
 * on read, so a read-back must never be hashed.
 *
 * `snapshotFingerprint` covers every field except itself and the live
 * projection (`status`, `reversal`, `replacedBy`), which change after creation.
 */
export function buildAgreementDocument(input: AgreementDocumentInput) {
  const { simulation } = input;
  const content = {
    id: input.id,
    contextId: input.contextId,
    folio: input.folio,
    title: input.title,
    note: input.note,
    replacesAgreementId: input.replacesAgreement?.id ?? null,
    replacesAgreement: input.replacesAgreement,
    generatedFrom: AGREEMENT_GENERATED_FROM,
    algorithmVersion: AGREEMENT_ALGORITHM_VERSION,
    notice: AGREEMENT_NOTICE,
    period: simulation.period,
    currency: simulation.currency,
    financialBase: simulation.financialBase,
    rule: simulation.rule,
    pools: simulation.pools,
    participants: simulation.members,
    totals: simulation.totals,
    warnings: simulation.warnings.filter(
      (warning) => !SIMULATION_ONLY_WARNING_CODES.includes(warning.code),
    ),
    simulationFingerprint: simulation.simulationFingerprint,
    occurredAt: input.occurredAt.toISOString(),
    receivedAt: input.receivedAt.toISOString(),
    createdBy: input.createdBy,
  };
  const snapshotFingerprint = canonicalDigest(content);
  return {
    ...content,
    snapshotFingerprint,
    // Live projection as created; the detail endpoint overrides these.
    status: 'active' as const,
    reversal: null,
    replacedBy: null,
  };
}

export type AgreementDocument = ReturnType<typeof buildAgreementDocument>;

/** True when a stored document still hashes to its own snapshotFingerprint. */
export function verifyAgreementDocument(
  document: Record<string, unknown>,
): boolean {
  const {
    snapshotFingerprint,
    status: _status,
    reversal: _reversal,
    replacedBy: _replacedBy,
    ...content
  } = document;
  return canonicalDigest(content) === snapshotFingerprint;
}
