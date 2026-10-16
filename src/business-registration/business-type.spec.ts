import { describe, expect, it } from 'vitest';
import {
  BUSINESS_TYPE_LABELS,
  BUSINESS_TYPES,
  businessTypeLabel,
} from './business-type.js';

describe('tipos de negocio', () => {
  it('son los 8 acordados, en este orden', () => {
    expect(BUSINESS_TYPES).toEqual([
      'bazar_o_tianguis',
      'abarrotes',
      'ropa_y_accesorios',
      'comida_y_bebidas',
      'plantas_y_jardineria',
      'artesanias',
      'servicios',
      'otro',
    ]);
  });

  it('cada uno tiene su etiqueta en español', () => {
    expect(BUSINESS_TYPE_LABELS).toEqual({
      bazar_o_tianguis: 'Bazar o tianguis',
      abarrotes: 'Abarrotes',
      ropa_y_accesorios: 'Ropa y accesorios',
      comida_y_bebidas: 'Comida y bebidas',
      plantas_y_jardineria: 'Plantas y jardinería',
      artesanias: 'Artesanías',
      servicios: 'Servicios',
      otro: 'Otro',
    });
  });

  it('businessTypeLabel devuelve la etiqueta o un guion si no hay tipo (filas antiguas)', () => {
    expect(businessTypeLabel('artesanias')).toBe('Artesanías');
    expect(businessTypeLabel(null)).toBe('—');
    expect(businessTypeLabel(undefined)).toBe('—');
  });
});
