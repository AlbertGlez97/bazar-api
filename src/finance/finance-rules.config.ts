import { canonicalDigest } from '../common/canonical-json.js';
import { MAX_MINOR_UNITS } from '../common/money.js';

/**
 * The profit-sharing rules a business agrees on (rule sets). A rule set is only
 * data: nothing here calculates money. The only hard restriction is that a split
 * of 100 % adds up to 100; everything unusual is a warning ({@link rulesWarnings})
 * that explains itself and never prevents saving.
 */
export const RULES_SCHEMA_VERSION = 1;

export const BUSINESS_PHASES = ['arranque', 'operacion', 'cierre'] as const;
export const RECOVERY_MODES = [
  'ninguna',
  'por_diferencia',
  'total',
  'proporcional',
] as const;
export const RECOVERY_TIMINGS = ['durante', 'al_cierre'] as const;
export const WORK_ORDERS = ['antes', 'despues'] as const;
export const PARTNER_EXPENSE_MODES = [
  'no_reembolsar',
  'reembolsar',
  'contar_como_aportacion',
] as const;

export type BusinessPhase = (typeof BUSINESS_PHASES)[number];
export type RecoveryMode = (typeof RECOVERY_MODES)[number];
export type RecoveryTiming = (typeof RECOVERY_TIMINGS)[number];
export type WorkOrder = (typeof WORK_ORDERS)[number];
export type PartnerExpenseMode = (typeof PARTNER_EXPENSE_MODES)[number];

export interface FinanceRulesConfig {
  schemaVersion: typeof RULES_SCHEMA_VERSION;
  /** 1. How the profit is split: by being a partner, by capital, by work. Adds up to 100. */
  profitBase: { partnerPct: number; capitalPct: number; workPct: number };
  /** 2. Share of the profit that is reinvested, per phase, and the business's current phase. */
  reinvestment: {
    currentPhase: BusinessPhase;
    arranquePct: number;
    operacionPct: number;
    cierrePct: number;
    /** Stop reinvesting once this much has been reinvested; null = no ceiling. */
    untilAmountMinor: number | null;
  };
  /** 3. How and when a partner's capital comes back. */
  capitalRecovery: { mode: RecoveryMode; timing: RecoveryTiming };
  /** 4. Whether hours are paid among partners, before or after capital, by rate or by share. */
  work: {
    payHours: boolean;
    order: WorkOrder;
    pay:
      | { kind: 'por_hora'; rateMinorPerHour: number }
      | { kind: 'porcentaje'; pct: number };
  };
  /** 5. What happens with expenses a partner paid from their own pocket. */
  partnerExpenses: PartnerExpenseMode;
  /** 6. What is set aside before sharing. */
  reserves:
    | { kind: 'porcentaje'; pct: number }
    | { kind: 'monto'; amountMinor: number };
  /** 7. Partner loans. */
  partnerLoans: { repayBeforeCapital: boolean };
}

export type ParsedRules =
  | { ok: true; config: FinanceRulesConfig }
  | { ok: false; errors: string[] };

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Percentages are whole hundredths (0.01 %) so sums are exact integers. */
const hundredths = (pct: number) => Math.round(pct * 100);
const isPct = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 100 &&
  Math.abs(value * 100 - hundredths(value)) < 1e-6;
const isMinor = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= MAX_MINOR_UNITS;
const oneOf = <T extends string>(
  list: readonly T[],
  value: unknown,
): value is T => typeof value === 'string' && list.includes(value as T);

/** Reads one object, rejects unknown keys, and reports every problem it finds. */
class Reader {
  constructor(
    private readonly errors: string[],
    private readonly path: string,
    private readonly raw: Raw | null,
    allowed: readonly string[],
  ) {
    if (raw)
      for (const key of Object.keys(raw))
        if (!allowed.includes(key)) this.fail(key, 'is not allowed');
  }
  private at(key: string) {
    return this.path ? `${this.path}.${key}` : key;
  }
  fail(key: string, message: string) {
    this.errors.push(`${this.at(key)}: ${message}`);
  }
  pct(key: string): number | null {
    const value = this.raw?.[key];
    if (isPct(value)) return value;
    this.fail(key, 'must be a number from 0 to 100 with at most 2 decimals');
    return null;
  }
  minor(key: string): number | null {
    const value = this.raw?.[key];
    if (isMinor(value)) return value;
    this.fail(key, `must be a whole number from 0 to ${MAX_MINOR_UNITS}`);
    return null;
  }
  bool(key: string): boolean | null {
    const value = this.raw?.[key];
    if (typeof value === 'boolean') return value;
    this.fail(key, 'must be true or false');
    return null;
  }
  choice<T extends string>(key: string, list: readonly T[]): T | null {
    const value = this.raw?.[key];
    if (oneOf(list, value)) return value;
    this.fail(key, `must be one of ${list.join(', ')}`);
    return null;
  }
  object(key: string): Raw | null {
    const value = this.raw?.[key];
    if (isRecord(value)) return value;
    this.fail(key, 'must be an object');
    return null;
  }
}

function formatPct(totalHundredths: number): string {
  return String(Number((totalHundredths / 100).toFixed(2)));
}

/**
 * Strict parser: rebuilds a clean configuration or lists EVERY problem. It
 * never accepts unknown keys and never invents defaults.
 */
export function parseRulesConfig(input: unknown): ParsedRules {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['config: must be an object'] };
  const root = new Reader(errors, '', input, [
    'schemaVersion',
    'profitBase',
    'reinvestment',
    'capitalRecovery',
    'work',
    'partnerExpenses',
    'reserves',
    'partnerLoans',
  ]);
  if (input.schemaVersion !== RULES_SCHEMA_VERSION)
    root.fail('schemaVersion', `must be ${RULES_SCHEMA_VERSION}`);

  const baseRaw = root.object('profitBase');
  const base = new Reader(errors, 'profitBase', baseRaw, [
    'partnerPct',
    'capitalPct',
    'workPct',
  ]);
  const partnerPct = base.pct('partnerPct');
  const capitalPct = base.pct('capitalPct');
  const workPct = base.pct('workPct');
  if (partnerPct !== null && capitalPct !== null && workPct !== null) {
    const total =
      hundredths(partnerPct) + hundredths(capitalPct) + hundredths(workPct);
    if (total !== 10000)
      errors.push(
        `profitBase: partnerPct, capitalPct and workPct must add up to 100 (they add up to ${formatPct(total)})`,
      );
  }

  const reinvRaw = root.object('reinvestment');
  const reinv = new Reader(errors, 'reinvestment', reinvRaw, [
    'currentPhase',
    'arranquePct',
    'operacionPct',
    'cierrePct',
    'untilAmountMinor',
  ]);
  const currentPhase = reinv.choice('currentPhase', BUSINESS_PHASES);
  const arranquePct = reinv.pct('arranquePct');
  const operacionPct = reinv.pct('operacionPct');
  const cierrePct = reinv.pct('cierrePct');
  let untilAmountMinor: number | null = null;
  if (reinvRaw && reinvRaw.untilAmountMinor !== null)
    untilAmountMinor = reinv.minor('untilAmountMinor');
  else if (reinvRaw && !('untilAmountMinor' in reinvRaw))
    reinv.fail('untilAmountMinor', 'is required (use null for no ceiling)');

  const recRaw = root.object('capitalRecovery');
  const rec = new Reader(errors, 'capitalRecovery', recRaw, ['mode', 'timing']);
  const mode = rec.choice('mode', RECOVERY_MODES);
  const timing = rec.choice('timing', RECOVERY_TIMINGS);

  const workRaw = root.object('work');
  const work = new Reader(errors, 'work', workRaw, [
    'payHours',
    'order',
    'pay',
  ]);
  const payHours = work.bool('payHours');
  const order = work.choice('order', WORK_ORDERS);
  const payRaw = work.object('pay');
  let pay: FinanceRulesConfig['work']['pay'] | null = null;
  if (payRaw) {
    if (payRaw.kind === 'por_hora') {
      const rate = new Reader(errors, 'work.pay', payRaw, [
        'kind',
        'rateMinorPerHour',
      ]).minor('rateMinorPerHour');
      if (rate !== null) pay = { kind: 'por_hora', rateMinorPerHour: rate };
    } else if (payRaw.kind === 'porcentaje') {
      const pct = new Reader(errors, 'work.pay', payRaw, ['kind', 'pct']).pct(
        'pct',
      );
      if (pct !== null) pay = { kind: 'porcentaje', pct };
    } else {
      new Reader(errors, 'work.pay', payRaw, ['kind']).fail(
        'kind',
        'must be one of por_hora, porcentaje',
      );
    }
  }

  const partnerExpenses = root.choice('partnerExpenses', PARTNER_EXPENSE_MODES);

  const resRaw = root.object('reserves');
  let reserves: FinanceRulesConfig['reserves'] | null = null;
  if (resRaw) {
    if (resRaw.kind === 'porcentaje') {
      const pct = new Reader(errors, 'reserves', resRaw, ['kind', 'pct']).pct(
        'pct',
      );
      if (pct !== null) reserves = { kind: 'porcentaje', pct };
    } else if (resRaw.kind === 'monto') {
      const amount = new Reader(errors, 'reserves', resRaw, [
        'kind',
        'amountMinor',
      ]).minor('amountMinor');
      if (amount !== null) reserves = { kind: 'monto', amountMinor: amount };
    } else {
      new Reader(errors, 'reserves', resRaw, ['kind']).fail(
        'kind',
        'must be one of porcentaje, monto',
      );
    }
  }

  const loansRaw = root.object('partnerLoans');
  const repayBeforeCapital = new Reader(errors, 'partnerLoans', loansRaw, [
    'repayBeforeCapital',
  ]).bool('repayBeforeCapital');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      schemaVersion: RULES_SCHEMA_VERSION,
      profitBase: {
        partnerPct: partnerPct!,
        capitalPct: capitalPct!,
        workPct: workPct!,
      },
      reinvestment: {
        currentPhase: currentPhase!,
        arranquePct: arranquePct!,
        operacionPct: operacionPct!,
        cierrePct: cierrePct!,
        untilAmountMinor,
      },
      capitalRecovery: { mode: mode!, timing: timing! },
      work: { payHours: payHours!, order: order!, pay: pay! },
      partnerExpenses: partnerExpenses!,
      reserves: reserves!,
      partnerLoans: { repayBeforeCapital: repayBeforeCapital! },
    },
  };
}

/** sha256 of the canonical JSON: what a partner approves and what never changes afterwards. */
export function configHash(config: FinanceRulesConfig): string {
  return canonicalDigest(config);
}

export interface RulesWarning {
  code: string;
  message: string;
}

/**
 * Orientation, never a block: unusual (not wrong) choices explained in plain
 * Spanish, one short sentence at a time (20 words or fewer each).
 */
export function rulesWarnings(config: FinanceRulesConfig): RulesWarning[] {
  const out: RulesWarning[] = [];
  const add = (code: string, message: string) => out.push({ code, message });
  const { reinvestment, capitalRecovery, work, profitBase, reserves } = config;

  if (reinvestment.arranquePct < 50)
    add(
      'REINVEST_LOW_AT_START',
      'En arranque conviene reinvertir casi todo. El negocio aún no prueba que funciona. Puedes dejarlo así si lo decidieron.',
    );
  if (reinvestment.cierrePct >= 50)
    add(
      'REINVEST_HIGH_AT_CLOSE',
      'En el cierre se reinvierte mucho. Si el negocio ya termina, esa plata no volvería a ustedes.',
    );
  if (capitalRecovery.mode === 'total' && capitalRecovery.timing === 'durante')
    add(
      'RECOVERY_TOTAL_DURING',
      'Devolver todo el capital durante la operación puede dejar poco efectivo para el negocio.',
    );
  if (work.payHours) {
    const zero =
      work.pay.kind === 'por_hora'
        ? work.pay.rateMinorPerHour === 0
        : work.pay.pct === 0;
    if (zero)
      add(
        'WORK_PAY_ZERO',
        'Marcaste pagar horas, pero la tarifa está en cero. Así no se pagará nada por trabajo.',
      );
    if (profitBase.workPct > 0)
      add(
        'WORK_COUNTED_TWICE',
        'Pagas las horas y además das parte de la utilidad al trabajo. Revisa que no se cuente dos veces.',
      );
  }
  if (profitBase.capitalPct === 100 && capitalRecovery.mode !== 'ninguna')
    add(
      'CAPITAL_RETURNED_TWICE',
      'Toda la utilidad va al capital y además se devuelve el capital. Revisa que no se pague dos veces.',
    );
  if (reserves.kind === 'porcentaje' && reserves.pct >= 50)
    add(
      'RESERVES_HIGH',
      'Apartas la mitad o más para reservas. Quedará poco para repartir.',
    );
  return out;
}
