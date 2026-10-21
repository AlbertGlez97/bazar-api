import { canonicalJson } from '../common/canonical-json.js';
import { formatCurrency } from '../common/money.js';
import type { FinanceRulesConfig } from './finance-rules.config.js';

/**
 * The rules in plain Spanish, one short sentence each (20 words or fewer), for the approval email
 * and the public page. Nothing here calculates money: it only says what was agreed.
 */

const PHASE: Record<FinanceRulesConfig['reinvestment']['currentPhase'], string> = {
  arranque: 'arranque',
  operacion: 'operación',
  cierre: 'cierre',
};
const TIMING: Record<FinanceRulesConfig['capitalRecovery']['timing'], string> = {
  durante: 'durante la operación',
  al_cierre: 'solo al cierre',
};

const pct = (value: number) => `${value} %`;

/** One agreed topic: its name and the sentence that says what was agreed. */
interface Section {
  topic: string;
  line: string;
  /** What decides whether the topic changed between two versions. */
  key: unknown;
}

function sections(config: FinanceRulesConfig): Section[] {
  const { profitBase, reinvestment, capitalRecovery, work, partnerExpenses, reserves, partnerLoans } = config;
  const ceiling =
    reinvestment.untilAmountMinor === null
      ? ''
      : ` Se deja de reinvertir al llegar a ${formatCurrency(reinvestment.untilAmountMinor)}.`;
  const recovery = {
    ninguna: 'El capital de los socios no se devuelve.',
    por_diferencia: `El capital se devuelve por diferencia, ${TIMING[capitalRecovery.timing]}.`,
    total: `Se devuelve todo el capital, ${TIMING[capitalRecovery.timing]}.`,
    proporcional: `El capital se devuelve en proporción, ${TIMING[capitalRecovery.timing]}.`,
  }[capitalRecovery.mode];
  const when = work.order === 'antes' ? 'antes' : 'después';
  const hours = !work.payHours
    ? 'Las horas de trabajo no se pagan aparte.'
    : work.pay.kind === 'por_hora'
      ? `Las horas se pagan a ${formatCurrency(work.pay.rateMinorPerHour)} cada una, ${when} del capital.`
      : `Las horas se pagan con ${pct(work.pay.pct)} del reparto, ${when} del capital.`;
  const expenses = {
    no_reembolsar: 'Los gastos que un socio paga de su bolsillo no se reembolsan.',
    reembolsar: 'Los gastos que un socio paga de su bolsillo se reembolsan.',
    contar_como_aportacion: 'Los gastos que un socio paga de su bolsillo cuentan como aportación.',
  }[partnerExpenses];
  return [
    {
      topic: 'Reparto de la utilidad',
      line: `La utilidad va ${pct(profitBase.partnerPct)} por ser socio, ${pct(profitBase.capitalPct)} por capital y ${pct(profitBase.workPct)} por trabajo.`,
      key: profitBase,
    },
    {
      topic: 'Reinversión',
      line: `Se reinvierte ${pct(reinvestment.arranquePct)} en arranque, ${pct(reinvestment.operacionPct)} en operación y ${pct(reinvestment.cierrePct)} en cierre. Hoy: ${PHASE[reinvestment.currentPhase]}.${ceiling}`,
      key: reinvestment,
    },
    { topic: 'Devolución del capital', line: recovery, key: capitalRecovery },
    { topic: 'Pago de horas', line: hours, key: work },
    { topic: 'Gastos de socios', line: expenses, key: partnerExpenses },
    {
      topic: 'Reservas',
      line:
        reserves.kind === 'porcentaje'
          ? `Se aparta ${pct(reserves.pct)} para reservas antes de repartir.`
          : `Se aparta ${formatCurrency(reserves.amountMinor)} para reservas antes de repartir.`,
      key: reserves,
    },
    {
      topic: 'Préstamos de socios',
      line: partnerLoans.repayBeforeCapital
        ? 'Los préstamos de socios se pagan antes de devolver capital.'
        : 'Los préstamos de socios se pagan después de devolver capital.',
      key: partnerLoans,
    },
  ];
}

/** Every rule, in plain words. */
export function describeRules(config: FinanceRulesConfig): string[] {
  return sections(config).map((section) => section.line);
}

export interface RuleChange {
  topic: string;
  before: string;
  after: string;
}

/** What differs between two versions, one entry per topic that changed; empty when nothing did. */
export function describeChanges(before: FinanceRulesConfig, after: FinanceRulesConfig): RuleChange[] {
  const old = sections(before);
  return sections(after).flatMap((section, index) =>
    canonicalJson(section.key) === canonicalJson(old[index]!.key)
      ? []
      : [{ topic: section.topic, before: old[index]!.line, after: section.line }],
  );
}
