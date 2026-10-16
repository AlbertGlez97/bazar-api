/** Tipos de negocio de la solicitud de registro (los mismos valores que el enum de la base de datos). */
export const BUSINESS_TYPES = [
  'bazar_o_tianguis',
  'abarrotes',
  'ropa_y_accesorios',
  'comida_y_bebidas',
  'plantas_y_jardineria',
  'artesanias',
  'servicios',
  'otro',
] as const;

export type BusinessTypeValue = (typeof BUSINESS_TYPES)[number];

/** Etiquetas en español: lo que ve la persona y el aprobador. */
export const BUSINESS_TYPE_LABELS: Record<BusinessTypeValue, string> = {
  bazar_o_tianguis: 'Bazar o tianguis',
  abarrotes: 'Abarrotes',
  ropa_y_accesorios: 'Ropa y accesorios',
  comida_y_bebidas: 'Comida y bebidas',
  plantas_y_jardineria: 'Plantas y jardinería',
  artesanias: 'Artesanías',
  servicios: 'Servicios',
  otro: 'Otro',
};

/** La etiqueta, o un guion si la solicitud es anterior a este campo. */
export function businessTypeLabel(
  type: BusinessTypeValue | null | undefined,
): string {
  return type ? BUSINESS_TYPE_LABELS[type] : '—';
}
