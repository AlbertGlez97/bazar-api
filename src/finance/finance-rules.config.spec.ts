import { describe, expect, it } from 'vitest';
import {
  RULES_SCHEMA_VERSION,
  configHash,
  parseRulesConfig,
  rulesWarnings,
  type FinanceRulesConfig,
} from './finance-rules.config.js';

/** A complete, valid configuration; each test changes only what it needs. */
const valid = (): FinanceRulesConfig => ({
  schemaVersion: RULES_SCHEMA_VERSION,
  profitBase: { partnerPct: 50, capitalPct: 30, workPct: 20 },
  reinvestment: {
    currentPhase: 'arranque',
    arranquePct: 100,
    operacionPct: 50,
    cierrePct: 0,
    untilAmountMinor: null,
  },
  capitalRecovery: { mode: 'por_diferencia', timing: 'durante' },
  work: {
    payHours: true,
    order: 'antes',
    pay: { kind: 'por_hora', rateMinorPerHour: 5000 },
  },
  partnerExpenses: 'reembolsar',
  reserves: { kind: 'porcentaje', pct: 10 },
  partnerLoans: { repayBeforeCapital: true },
});

const parse = (patch: (c: Record<string, any>) => void) => {
  const input = JSON.parse(JSON.stringify(valid())) as Record<string, any>;
  patch(input);
  return parseRulesConfig(input);
};
const errorsOf = (patch: (c: Record<string, any>) => void) => {
  const result = parse(patch);
  return result.ok ? [] : result.errors;
};

describe('parseRulesConfig: lo válido', () => {
  it('acepta una configuración completa y la devuelve igual', () => {
    const result = parseRulesConfig(valid());
    expect(result).toEqual({ ok: true, config: valid() });
  });

  it('acepta los extremos: 0 y 100, montos en 0, tarifa por porcentaje y reserva fija', () => {
    const result = parse((c) => {
      c.profitBase = { partnerPct: 100, capitalPct: 0, workPct: 0 };
      c.reinvestment.arranquePct = 0;
      c.reinvestment.cierrePct = 100;
      c.reinvestment.untilAmountMinor = 0;
      c.work = { payHours: false, order: 'despues', pay: { kind: 'porcentaje', pct: 0 } };
      c.reserves = { kind: 'monto', amountMinor: 0 };
    });
    expect(result.ok).toBe(true);
  });

  it('acepta dos decimales en los porcentajes', () => {
    const result = parse((c) => {
      c.profitBase = { partnerPct: 33.33, capitalPct: 33.33, workPct: 33.34 };
      c.reinvestment.operacionPct = 12.5;
    });
    expect(result.ok).toBe(true);
  });

  it('cada opción de cada engrane es válida', () => {
    for (const mode of ['ninguna', 'por_diferencia', 'total', 'proporcional'])
      expect(parse((c) => (c.capitalRecovery.mode = mode)).ok).toBe(true);
    for (const timing of ['durante', 'al_cierre'])
      expect(parse((c) => (c.capitalRecovery.timing = timing)).ok).toBe(true);
    for (const phase of ['arranque', 'operacion', 'cierre'])
      expect(parse((c) => (c.reinvestment.currentPhase = phase)).ok).toBe(true);
    for (const expense of ['no_reembolsar', 'reembolsar', 'contar_como_aportacion'])
      expect(parse((c) => (c.partnerExpenses = expense)).ok).toBe(true);
    for (const order of ['antes', 'despues'])
      expect(parse((c) => (c.work.order = order)).ok).toBe(true);
  });
});

describe('parseRulesConfig: la única restricción dura es que el reparto sume 100', () => {
  it('rechaza una base de utilidad que no suma 100, diciendo cuánto suma', () => {
    const errors = errorsOf((c) => (c.profitBase = { partnerPct: 50, capitalPct: 30, workPct: 10 }));
    expect(errors).toEqual(['profitBase: partnerPct, capitalPct y workPct deben sumar 100 (hoy suman 90)']);
  });

  it('suma exacta con decimales (sin errores de coma flotante)', () => {
    expect(parse((c) => (c.profitBase = { partnerPct: 0.1, capitalPct: 0.2, workPct: 99.7 })).ok).toBe(true);
    expect(parse((c) => (c.profitBase = { partnerPct: 33.33, capitalPct: 33.33, workPct: 33.33 })).ok).toBe(false);
  });

  it('un porcentaje de más de 100 o negativo se rechaza', () => {
    expect(errorsOf((c) => (c.profitBase.partnerPct = 101))).not.toEqual([]);
    expect(errorsOf((c) => (c.profitBase.partnerPct = -1))).not.toEqual([]);
    expect(errorsOf((c) => (c.reinvestment.arranquePct = 100.01))).not.toEqual([]);
    expect(errorsOf((c) => (c.reserves = { kind: 'porcentaje', pct: -0.01 }))).not.toEqual([]);
  });

  it('más de dos decimales se rechaza', () => {
    expect(errorsOf((c) => (c.reinvestment.operacionPct = 12.345))).not.toEqual([]);
  });

  it('nada más se bloquea: ni una reinversión del 100 % en todas las fases ni una tarifa enorme', () => {
    const result = parse((c) => {
      c.reinvestment.arranquePct = 100;
      c.reinvestment.operacionPct = 100;
      c.reinvestment.cierrePct = 100;
      c.work.pay = { kind: 'por_hora', rateMinorPerHour: 2_147_483_647 };
      c.reserves = { kind: 'porcentaje', pct: 100 };
      c.capitalRecovery = { mode: 'total', timing: 'durante' };
    });
    expect(result.ok).toBe(true);
  });
});

describe('parseRulesConfig: la forma', () => {
  it.each([null, undefined, 'x', 5, [], true])('rechaza %j como configuración', (value) => {
    expect(parseRulesConfig(value).ok).toBe(false);
  });

  it('exige la versión de esquema vigente', () => {
    expect(errorsOf((c) => (c.schemaVersion = 2))).toEqual(['schemaVersion: debe ser 1']);
    expect(errorsOf((c) => delete c.schemaVersion)).toEqual(['schemaVersion: debe ser 1']);
  });

  it.each(['profitBase', 'reinvestment', 'capitalRecovery', 'work', 'partnerExpenses', 'reserves', 'partnerLoans'])(
    'exige %s',
    (key) => {
      expect(errorsOf((c) => delete c[key]).length).toBeGreaterThan(0);
    },
  );

  it('rechaza claves desconocidas, también dentro de cada engrane', () => {
    expect(errorsOf((c) => (c.extra = 1))).toEqual(['extra: no está permitido']);
    expect(errorsOf((c) => (c.profitBase.extra = 1))).toEqual(['profitBase.extra: no está permitido']);
    expect(errorsOf((c) => (c.work.pay.extra = 1))).toEqual(['work.pay.extra: no está permitido']);
  });

  it('rechaza opciones que no existen y tipos equivocados', () => {
    expect(errorsOf((c) => (c.capitalRecovery.mode = 'mitad')).length).toBe(1);
    expect(errorsOf((c) => (c.capitalRecovery.timing = 'nunca')).length).toBe(1);
    expect(errorsOf((c) => (c.partnerExpenses = 'si')).length).toBe(1);
    expect(errorsOf((c) => (c.work.payHours = 'si')).length).toBe(1);
    expect(errorsOf((c) => (c.partnerLoans.repayBeforeCapital = 1)).length).toBe(1);
    expect(errorsOf((c) => (c.profitBase.partnerPct = '50')).length).toBeGreaterThan(0);
    expect(errorsOf((c) => (c.reinvestment.currentPhase = 'otra')).length).toBe(1);
  });

  it('montos: enteros, no negativos y dentro del máximo', () => {
    expect(errorsOf((c) => (c.work.pay.rateMinorPerHour = 12.5)).length).toBe(1);
    expect(errorsOf((c) => (c.work.pay.rateMinorPerHour = -1)).length).toBe(1);
    expect(errorsOf((c) => (c.work.pay.rateMinorPerHour = 2_147_483_648)).length).toBe(1);
    expect(errorsOf((c) => (c.reinvestment.untilAmountMinor = -5)).length).toBe(1);
    expect(errorsOf((c) => (c.reserves = { kind: 'monto', amountMinor: 1.5 })).length).toBe(1);
  });

  it('la tarifa y la reserva eligen una sola forma', () => {
    expect(errorsOf((c) => (c.work.pay = { kind: 'otra' })).length).toBeGreaterThan(0);
    expect(errorsOf((c) => (c.work.pay = { kind: 'por_hora', pct: 5 })).length).toBeGreaterThan(0);
    expect(errorsOf((c) => (c.reserves = { kind: 'porcentaje', amountMinor: 5 })).length).toBeGreaterThan(0);
  });

  it('junta todos los errores en vez de parar en el primero', () => {
    const errors = errorsOf((c) => {
      c.capitalRecovery.mode = 'x';
      c.partnerExpenses = 'y';
    });
    expect(errors).toHaveLength(2);
  });
});

describe('configHash', () => {
  it('es el mismo para la misma configuración, sin importar el orden de las claves', () => {
    const reordered = JSON.parse(JSON.stringify(valid()));
    const swapped = { partnerLoans: reordered.partnerLoans, ...reordered };
    expect(configHash(valid())).toBe(configHash(swapped as FinanceRulesConfig));
    expect(configHash(valid())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cambia con cualquier valor', () => {
    const changed = valid();
    changed.reserves = { kind: 'porcentaje', pct: 10.01 };
    expect(configHash(changed)).not.toBe(configHash(valid()));
    const phase = valid();
    phase.reinvestment.currentPhase = 'operacion';
    expect(configHash(phase)).not.toBe(configHash(valid()));
  });
});

describe('rulesWarnings: avisos que orientan y nunca bloquean', () => {
  const codes = (patch: (c: FinanceRulesConfig) => void) => {
    const config = valid();
    patch(config);
    return rulesWarnings(config).map((w) => w.code);
  };

  it('una configuración razonable casi no avisa', () => {
    const calm = valid();
    calm.work.payHours = false;
    calm.profitBase = { partnerPct: 50, capitalPct: 50, workPct: 0 };
    calm.capitalRecovery.mode = 'ninguna';
    expect(rulesWarnings(calm)).toEqual([]);
  });

  it('avisa cuando en arranque se reinvierte poco', () => {
    expect(codes((c) => (c.reinvestment.arranquePct = 20))).toContain('REINVEST_LOW_AT_START');
    expect(codes((c) => (c.reinvestment.arranquePct = 100))).not.toContain('REINVEST_LOW_AT_START');
  });

  it('avisa cuando en el cierre se reinvierte mucho', () => {
    expect(codes((c) => (c.reinvestment.cierrePct = 60))).toContain('REINVEST_HIGH_AT_CLOSE');
  });

  it('avisa si se devuelve todo el capital durante la operación', () => {
    expect(codes((c) => (c.capitalRecovery = { mode: 'total', timing: 'durante' }))).toContain('RECOVERY_TOTAL_DURING');
    expect(codes((c) => (c.capitalRecovery = { mode: 'total', timing: 'al_cierre' }))).not.toContain('RECOVERY_TOTAL_DURING');
  });

  it('avisa si se paga trabajo con tarifa en cero', () => {
    expect(codes((c) => (c.work.pay = { kind: 'por_hora', rateMinorPerHour: 0 }))).toContain('WORK_PAY_ZERO');
    expect(codes((c) => (c.work.pay = { kind: 'porcentaje', pct: 0 }))).toContain('WORK_PAY_ZERO');
    expect(codes((c) => (c.work.payHours = false))).not.toContain('WORK_PAY_ZERO');
  });

  it('avisa si el trabajo cuenta dos veces (se paga y además lleva parte de la utilidad)', () => {
    expect(codes(() => undefined)).toContain('WORK_COUNTED_TWICE');
    expect(codes((c) => (c.profitBase = { partnerPct: 50, capitalPct: 50, workPct: 0 }))).not.toContain('WORK_COUNTED_TWICE');
  });

  it('avisa si todo va al capital y además se devuelve el capital', () => {
    expect(
      codes((c) => {
        c.profitBase = { partnerPct: 0, capitalPct: 100, workPct: 0 };
      }),
    ).toContain('CAPITAL_RETURNED_TWICE');
  });

  it('avisa de reservas muy altas', () => {
    expect(codes((c) => (c.reserves = { kind: 'porcentaje', pct: 50 }))).toContain('RESERVES_HIGH');
    expect(codes((c) => (c.reserves = { kind: 'porcentaje', pct: 49.99 }))).not.toContain('RESERVES_HIGH');
    expect(codes((c) => (c.reserves = { kind: 'monto', amountMinor: 999_999_999 }))).not.toContain('RESERVES_HIGH');
  });

  it('cada aviso tiene mensaje en español de 20 palabras o menos', () => {
    const noisy = valid();
    noisy.reinvestment = { currentPhase: 'arranque', arranquePct: 0, operacionPct: 0, cierrePct: 100, untilAmountMinor: null };
    noisy.capitalRecovery = { mode: 'total', timing: 'durante' };
    noisy.work.pay = { kind: 'por_hora', rateMinorPerHour: 0 };
    noisy.profitBase = { partnerPct: 0, capitalPct: 100, workPct: 0 };
    noisy.reserves = { kind: 'porcentaje', pct: 80 };
    const warnings = rulesWarnings(noisy);
    expect(warnings.length).toBeGreaterThanOrEqual(5);
    for (const warning of warnings) {
      for (const sentence of warning.message.split(/(?<=[.!?])\s+/))
        expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(20);
      expect(warning.message).not.toMatch(/\b(error|invalid|must)\b/i);
    }
  });
});
