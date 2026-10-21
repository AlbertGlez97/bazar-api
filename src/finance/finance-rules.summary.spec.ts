import { describe, expect, it } from 'vitest';
import { RULES_SCHEMA_VERSION, type FinanceRulesConfig } from './finance-rules.config.js';
import { describeChanges, describeRules } from './finance-rules.summary.js';

const base = (): FinanceRulesConfig => ({
  schemaVersion: RULES_SCHEMA_VERSION,
  profitBase: { partnerPct: 50, capitalPct: 30, workPct: 20 },
  reinvestment: { currentPhase: 'operacion', arranquePct: 100, operacionPct: 50, cierrePct: 0, untilAmountMinor: null },
  capitalRecovery: { mode: 'por_diferencia', timing: 'durante' },
  work: { payHours: false, order: 'antes', pay: { kind: 'por_hora', rateMinorPerHour: 5000 } },
  partnerExpenses: 'reembolsar',
  reserves: { kind: 'porcentaje', pct: 10 },
  partnerLoans: { repayBeforeCapital: true },
});
/** Words of the longest SENTENCE: the limit for text people read is 20 words per sentence. */
const longestSentence = (line: string) =>
  Math.max(...line.split('. ').map((sentence) => sentence.split(' ').length));

describe('describeRules', () => {
  it('dice cada regla en una frase corta y sencilla', () => {
    expect(describeRules(base())).toEqual([
      'La utilidad va 50 % por ser socio, 30 % por capital y 20 % por trabajo.',
      'Se reinvierte 100 % en arranque, 50 % en operación y 0 % en cierre. Hoy: operación.',
      'El capital se devuelve por diferencia, durante la operación.',
      'Las horas de trabajo no se pagan aparte.',
      'Los gastos que un socio paga de su bolsillo se reembolsan.',
      'Se aparta 10 % para reservas antes de repartir.',
      'Los préstamos de socios se pagan antes de devolver capital.',
    ]);
  });

  it('ninguna frase pasa de 20 palabras, ni siquiera con todas las opciones activadas', () => {
    const rich = base();
    rich.reinvestment = { currentPhase: 'arranque', arranquePct: 12.5, operacionPct: 33.33, cierrePct: 100, untilAmountMinor: 12345678 };
    rich.work = { payHours: true, order: 'despues', pay: { kind: 'por_hora', rateMinorPerHour: 123456 } };
    rich.reserves = { kind: 'monto', amountMinor: 99999 };
    for (const line of describeRules(rich)) expect(longestSentence(line)).toBeLessThanOrEqual(20);
    expect(describeRules(rich)[1]).toBe('Se reinvierte 12.5 % en arranque, 33.33 % en operación y 100 % en cierre. Hoy: arranque. Se deja de reinvertir al llegar a $123456.78.');
  });

  it.each([
    ['ninguna', 'durante', 'El capital de los socios no se devuelve.'],
    ['por_diferencia', 'al_cierre', 'El capital se devuelve por diferencia, solo al cierre.'],
    ['total', 'durante', 'Se devuelve todo el capital, durante la operación.'],
    ['proporcional', 'al_cierre', 'El capital se devuelve en proporción, solo al cierre.'],
  ] as const)('devolución del capital %s %s', (mode, timing, line) => {
    const config = base();
    config.capitalRecovery = { mode, timing };
    expect(describeRules(config)[2]).toBe(line);
  });

  it('el pago de horas dice cuánto, cómo y cuándo', () => {
    const config = base();
    config.work = { payHours: true, order: 'antes', pay: { kind: 'por_hora', rateMinorPerHour: 5000 } };
    expect(describeRules(config)[3]).toBe('Las horas se pagan a $50.00 cada una, antes del capital.');
    config.work = { payHours: true, order: 'despues', pay: { kind: 'porcentaje', pct: 15 } };
    expect(describeRules(config)[3]).toBe('Las horas se pagan con 15 % del reparto, después del capital.');
  });

  it.each([
    ['no_reembolsar', 'Los gastos que un socio paga de su bolsillo no se reembolsan.'],
    ['reembolsar', 'Los gastos que un socio paga de su bolsillo se reembolsan.'],
    ['contar_como_aportacion', 'Los gastos que un socio paga de su bolsillo cuentan como aportación.'],
  ] as const)('gastos de socios %s', (mode, line) => {
    const config = base();
    config.partnerExpenses = mode;
    expect(describeRules(config)[4]).toBe(line);
  });

  it('las reservas y los préstamos dicen lo que se acordó', () => {
    const config = base();
    config.reserves = { kind: 'monto', amountMinor: 250000 };
    config.partnerLoans = { repayBeforeCapital: false };
    expect(describeRules(config).slice(5)).toEqual([
      'Se aparta $2500.00 para reservas antes de repartir.',
      'Los préstamos de socios se pagan después de devolver capital.',
    ]);
  });
});

describe('describeChanges', () => {
  it('sin cambios no dice nada', () => {
    expect(describeChanges(base(), base())).toEqual([]);
  });

  it('dice solo lo que cambió, con el antes y el ahora de cada tema', () => {
    const after = base();
    after.reserves = { kind: 'porcentaje', pct: 25 };
    after.profitBase = { partnerPct: 40, capitalPct: 40, workPct: 20 };
    expect(describeChanges(base(), after)).toEqual([
      {
        topic: 'Reparto de la utilidad',
        before: 'La utilidad va 50 % por ser socio, 30 % por capital y 20 % por trabajo.',
        after: 'La utilidad va 40 % por ser socio, 40 % por capital y 20 % por trabajo.',
      },
      {
        topic: 'Reservas',
        before: 'Se aparta 10 % para reservas antes de repartir.',
        after: 'Se aparta 25 % para reservas antes de repartir.',
      },
    ]);
  });

  it('cada tema se compara por su contenido, sin importar el orden de las llaves', () => {
    const after = base();
    after.reinvestment = { untilAmountMinor: null, cierrePct: 0, operacionPct: 50, arranquePct: 100, currentPhase: 'operacion' };
    expect(describeChanges(base(), after)).toEqual([]);
    after.reinvestment.currentPhase = 'cierre';
    expect(describeChanges(base(), after).map((c) => c.topic)).toEqual(['Reinversión']);
  });

  it('cubre los siete temas', () => {
    const after = base();
    after.profitBase = { partnerPct: 100, capitalPct: 0, workPct: 0 };
    after.reinvestment.cierrePct = 10;
    after.capitalRecovery = { mode: 'total', timing: 'al_cierre' };
    after.work = { payHours: true, order: 'antes', pay: { kind: 'porcentaje', pct: 5 } };
    after.partnerExpenses = 'no_reembolsar';
    after.reserves = { kind: 'monto', amountMinor: 100 };
    after.partnerLoans = { repayBeforeCapital: false };
    expect(describeChanges(base(), after).map((c) => c.topic)).toEqual([
      'Reparto de la utilidad',
      'Reinversión',
      'Devolución del capital',
      'Pago de horas',
      'Gastos de socios',
      'Reservas',
      'Préstamos de socios',
    ]);
  });
});
