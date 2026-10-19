// Doble en memoria de PrismaService para las pruebas UNITARIAS del registro de negocios. No es un
// mock de llamadas: guarda filas de verdad, evalúa los `where` que usa el código (igualdad,
// not/gt/gte/lt/lte/in, OR, null) y revierte la transacción si la función lanza. Así las pruebas
// afirman EFECTOS (qué quedó guardado, qué se revirtió), no que se llamó a un método.
import { vi } from 'vitest';
import type { PrismaService } from '../../src/database/prisma.service.js';

export type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const time = (value: unknown): unknown => (value instanceof Date ? value.getTime() : value);

function matchesValue(actual: unknown, condition: unknown): boolean {
  if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
    const c = condition as Record<string, unknown>;
    return Object.entries(c).every(([op, expected]) => {
      const a = time(actual);
      const e = time(expected);
      switch (op) {
        case 'not':
          return a !== e;
        case 'gt':
          return a != null && (a as number) > (e as number);
        case 'gte':
          return a != null && (a as number) >= (e as number);
        case 'lt':
          return a != null && (a as number) < (e as number);
        case 'lte':
          return a != null && (a as number) <= (e as number);
        case 'in':
          return (expected as unknown[]).includes(actual);
        default:
          throw new Error(`Operador no soportado por el doble: ${op}`);
      }
    });
  }
  return time(actual) === time(condition) || (actual == null && condition == null);
}

export function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Where[]).some((branch) => matches(row, branch));
    if (key === 'AND') return (condition as Where[]).every((branch) => matches(row, branch));
    return matchesValue(row[key], condition);
  });
}

const DEFAULTS = (): Row => ({
  status: 'pendiente',
  telefono: null,
  tipoNegocio: null,
  queVende: null,
  dondeVende: null,
  recomendadoPor: null,
  legalVersion: null,
  legalAcceptedAt: null,
  emailVerifiedAt: null,
  emailTokenHash: null,
  emailTokenExpiresAt: null,
  verificationEmailsSent: 0,
  lastVerificationEmailAt: null,
  createdAt: new Date(),
  resolvedAt: null,
  createdContextId: null,
});

export class FakeRegistrationDb {
  rows: Row[] = [];
  /** Si una función lo pone, el siguiente `create` lanza ese error DESPUÉS de insertar `winner`. */
  raceOnNextCreate: Row | null = null;
  /** Error que lanza el próximo `create` (sin insertar nada). */
  failNextCreate: Error | null = null;
  transactionOptions: unknown[] = [];
  /** Filas que otra transacción SÍ confirmó (el ganador de una carrera): sobreviven al rollback. */
  private survivors: Row[] = [];

  seed(row: Row): Row {
    const full = { id: `seed-${this.rows.length + 1}`, ...DEFAULTS(), ...row };
    this.rows.push(full);
    return full;
  }

  byCorreo(correo: string): Row[] {
    return this.rows.filter((row) => row.correo === correo);
  }

  private model = {
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (this.failNextCreate) {
        const error = this.failNextCreate;
        this.failNextCreate = null;
        throw error;
      }
      if (this.raceOnNextCreate) {
        const winner = this.raceOnNextCreate;
        this.raceOnNextCreate = null;
        this.survivors.push(this.seed(winner));
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      const row = { ...DEFAULTS(), ...data };
      this.rows.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: { where?: Where }) => this.rows.find((row) => matches(row, where)) ?? null),
    findFirstOrThrow: vi.fn(async ({ where }: { where?: Where }) => {
      const found = this.rows.find((row) => matches(row, where));
      if (!found) throw new Error('No BusinessRegistrationRequest found');
      return found;
    }),
    findMany: vi.fn(async ({ where, take }: { where?: Where; take?: number }) =>
      this.rows.filter((row) => matches(row, where)).slice(0, take),
    ),
    count: vi.fn(async ({ where }: { where?: Where }) => this.rows.filter((row) => matches(row, where)).length),
    updateMany: vi.fn(async ({ where, data }: { where?: Where; data: Row }) => {
      const targets = this.rows.filter((row) => matches(row, where));
      for (const row of targets) {
        for (const [key, value] of Object.entries(data)) {
          const inc = (value as { increment?: number } | null)?.increment;
          row[key] = typeof inc === 'number' ? (row[key] as number) + inc : value;
        }
      }
      return { count: targets.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where?: Where }) => {
      const before = this.rows.length;
      this.rows = this.rows.filter((row) => !matches(row, where));
      return { count: before - this.rows.length };
    }),
  };

  /** Lo que el servicio recibe como PrismaService. */
  prisma = {
    businessRegistrationRequest: this.model,
    $transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>, options?: unknown): Promise<T> => {
      this.transactionOptions.push(options);
      const snapshot = this.rows.map((row) => ({ ...row }));
      this.survivors = [];
      try {
        return await fn({ businessRegistrationRequest: this.model });
      } catch (error) {
        this.rows = [...snapshot, ...this.survivors.filter((row) => !snapshot.some((s) => s.id === row.id))]; // rollback: nada queda a medias
        throw error;
      }
    }),
  } as unknown as PrismaService;
}
