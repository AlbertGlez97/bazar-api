// Pruebas unitarias de la limpieza de solicitudes: con la base en memoria se afirma QUÉ filas
// quedan y cuáles se borran, no solo que se llamó a deleteMany.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { CLEANUP_BATCH_SIZE, RegistrationCleanupService } from './registration-cleanup.service.js';
import { FakeRegistrationDb, type Row } from '../../test/support/fake-registration-db.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-19T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

describe('RegistrationCleanupService', () => {
  let db: FakeRegistrationDb;
  let service: RegistrationCleanupService;
  let logged: string[];
  const ids = () => db.rows.map((row) => row.id);
  const add = (id: string, over: Row) => db.seed({ id, correo: `${id}@example.com`, nombre: 'Ana', ...over });

  beforeEach(() => {
    db = new FakeRegistrationDb();
    service = new RegistrationCleanupService(db.prisma);
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
    }
  });

  afterEach(() => vi.restoreAllMocks());

  describe('sin confirmar el correo: 7 días', () => {
    it('borra la de 8 días y conserva la de 6', async () => {
      add('vieja', { status: 'pendiente_correo', createdAt: ago(8) });
      add('reciente', { status: 'pendiente_correo', createdAt: ago(6) });

      const deleted = await service.runBatch(NOW);

      expect(deleted).toBe(1);
      expect(ids()).toEqual(['reciente']);
    });

    it('justo en el límite (7 días exactos) todavía se conserva', async () => {
      add('limite', { status: 'pendiente_correo', createdAt: ago(7) });

      await service.runBatch(NOW);

      expect(ids()).toEqual(['limite']);
    });
  });

  describe('rechazadas: 30 días después de rechazarse', () => {
    it('borra la rechazada hace 31 días y conserva la de hace 29', async () => {
      add('vieja', { status: 'rechazado', resolvedAt: ago(31) });
      add('reciente', { status: 'rechazado', resolvedAt: ago(29) });

      await service.runBatch(NOW);

      expect(ids()).toEqual(['reciente']);
    });

    it('cuenta desde que se rechazó, no desde que se creó', async () => {
      add('creada-hace-mucho-rechazada-ayer', { status: 'rechazado', createdAt: ago(200), resolvedAt: ago(1) });

      await service.runBatch(NOW);

      expect(ids()).toEqual(['creada-hace-mucho-rechazada-ayer']);
    });
  });

  describe('vencidas: 30 días después de que venció el enlace de aprobación', () => {
    it('borra la pendiente cuyo enlace venció hace 31 días y conserva la de hace 29', async () => {
      add('vieja', { status: 'pendiente', tokenExpiresAt: ago(31) });
      add('reciente', { status: 'pendiente', tokenExpiresAt: ago(29) });

      await service.runBatch(NOW);

      expect(ids()).toEqual(['reciente']);
    });

    it('una pendiente con el enlace todavía vigente no se toca, por vieja que sea su creación', async () => {
      add('vigente', { status: 'pendiente', createdAt: ago(100), tokenExpiresAt: new Date(NOW.getTime() + DAY) });

      await service.runBatch(NOW);

      expect(ids()).toEqual(['vigente']);
    });
  });

  it('NUNCA borra una solicitud aprobada, por vieja que sea', async () => {
    add('aprobada', {
      status: 'aprobado',
      createdAt: ago(900),
      resolvedAt: ago(800),
      tokenExpiresAt: ago(700),
      createdContextId: 'ctx-1',
    });

    const deleted = await service.runBatch(NOW);

    expect(deleted).toBe(0);
    expect(ids()).toEqual(['aprobada']);
  });

  it('mezcla: borra solo lo vencido de cada categoría', async () => {
    add('a-sin-confirmar-vieja', { status: 'pendiente_correo', createdAt: ago(10) });
    add('b-sin-confirmar-nueva', { status: 'pendiente_correo', createdAt: ago(1) });
    add('c-rechazada-vieja', { status: 'rechazado', resolvedAt: ago(40) });
    add('d-vencida-vieja', { status: 'pendiente', tokenExpiresAt: ago(40) });
    add('e-aprobada', { status: 'aprobado', createdAt: ago(500) });

    const deleted = await service.runBatch(NOW);

    expect(deleted).toBe(3);
    expect(ids().sort((a, b) => a.localeCompare(b))).toEqual(['b-sin-confirmar-nueva', 'e-aprobada']);
  });

  describe('por lotes', () => {
    it('el tamaño de lote por defecto es 200', () => {
      expect(CLEANUP_BATCH_SIZE).toBe(200);
    });

    it('con lote de 2 borra a lo más 2 por pasada y la siguiente pasada sigue con el resto', async () => {
      for (let i = 0; i < 5; i += 1) add(`vieja-${i}`, { status: 'pendiente_correo', createdAt: ago(20) });

      expect(await service.runBatch(NOW, 2)).toBe(2);
      expect(db.rows).toHaveLength(3);
      expect(await service.runBatch(NOW, 2)).toBe(2);
      expect(await service.runBatch(NOW, 2)).toBe(1);
      expect(db.rows).toHaveLength(0);
    });

    it('el lote se reparte entre categorías sin pasarse del tope', async () => {
      add('p1', { status: 'pendiente_correo', createdAt: ago(20) });
      add('p2', { status: 'pendiente_correo', createdAt: ago(20) });
      add('r1', { status: 'rechazado', resolvedAt: ago(40) });
      add('r2', { status: 'rechazado', resolvedAt: ago(40) });

      const deleted = await service.runBatch(NOW, 3);

      expect(deleted).toBe(3);
      expect(db.rows).toHaveLength(1);
    });

    it('sin nada vencido no borra ni escribe en el log', async () => {
      add('nueva', { status: 'pendiente_correo', createdAt: ago(1) });

      expect(await service.runBatch(NOW)).toBe(0);
      expect(logged).toEqual([]);
    });
  });

  it('el log dice cuántas se borraron y no trae correos ni nombres', async () => {
    add('x', { status: 'pendiente_correo', createdAt: ago(20), nombre: 'Persona Secreta' });

    await service.runBatch(NOW);

    expect(logged).toEqual(['Limpieza de solicitudes: 1 borradas.']);
    expect(logged.join('\n')).not.toContain('Secreta');
    expect(logged.join('\n')).not.toContain('@');
  });

  it('usa la fecha de hoy cuando no se le da una', async () => {
    add('vieja', { status: 'pendiente_correo', createdAt: new Date(Date.now() - 8 * DAY) });
    add('nueva', { status: 'pendiente_correo', createdAt: new Date() });

    await service.runBatch();

    expect(ids()).toEqual(['nueva']);
  });

  describe('onApplicationBootstrap', () => {
    it('limpia al arrancar, sin esperar', async () => {
      add('vieja', { status: 'pendiente_correo', createdAt: ago(20) });

      service.onApplicationBootstrap();
      await vi.waitFor(() => expect(db.rows).toHaveLength(0));
    });

    it('si la limpieza falla, avisa solo con el tipo de error y NO impide arrancar', async () => {
      vi.spyOn(service, 'runBatch').mockRejectedValue(Object.assign(new Error('postgres://user:secreto@host'), { name: 'PrismaClientKnownRequestError' }));

      expect(() => service.onApplicationBootstrap()).not.toThrow();
      await vi.waitFor(() => expect(logged).toHaveLength(1));

      expect(logged[0]).toBe('La limpieza de solicitudes falló al arrancar: PrismaClientKnownRequestError');
      expect(logged[0]).not.toContain('secreto');
    });

    it('un error que no es Error también se maneja', async () => {
      vi.spyOn(service, 'runBatch').mockRejectedValue('boom');

      service.onApplicationBootstrap();
      await vi.waitFor(() => expect(logged).toHaveLength(1));

      expect(logged[0]).toBe('La limpieza de solicitudes falló al arrancar: error');
    });
  });
});
