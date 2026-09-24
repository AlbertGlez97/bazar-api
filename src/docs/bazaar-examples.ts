/** Fictional documentation fixtures, not seed data or usable credentials. */
export const ids = {
  alberto: '10000000-0000-4000-8000-000000000001',
  adid: '10000000-0000-4000-8000-000000000002',
  carlos: '10000000-0000-4000-8000-000000000003',
  javier: '10000000-0000-4000-8000-000000000004',
  device: '20000000-0000-4000-8000-000000000001',
  spiderMan: '30000000-0000-4000-8000-000000000001',
  godOfWar: '30000000-0000-4000-8000-000000000002',
  granTurismo: '30000000-0000-4000-8000-000000000003',
  sale: '40000000-0000-4000-8000-000000000001',
  rejectedSale: '40000000-0000-4000-8000-000000000002',
  incident: '50000000-0000-4000-8000-000000000001',
  debtor: '60000000-0000-4000-8000-000000000001',
  debt: '70000000-0000-4000-8000-000000000001',
  payment: '80000000-0000-4000-8000-000000000001',
};
export const createdAt = '2026-09-23T12:00:00.000Z';
export const contextId = 'ps5-bazaar-example';
export const members = [
  { id: ids.adid, name: 'Adid', role: 'socio' },
  { id: ids.alberto, name: 'Alberto', role: 'socio' },
  { id: ids.carlos, name: 'Carlos', role: 'colaborador' },
  { id: ids.javier, name: 'Javier', role: 'colaborador' },
];
export const productInput = {
  name: 'Marvel’s Spider-Man 2 — PS5',
  tipo: 'unica',
  unitPriceMinor: 125000,
  initialStock: 1,
  category: 'PS5 physical games',
  purchaseCostMinor: 90000,
  supplier: 'Local trade-in',
  notes: 'Used disc and original case, tested.',
};
export const product = {
  id: ids.spiderMan,
  contextId,
  ...productInput,
  stock: 1,
  createdAt,
  image: null,
};
export const godOfWar = {
  ...product,
  id: ids.godOfWar,
  name: 'God of War Ragnarök — PS5',
  tipo: 'cantidad',
  unitPriceMinor: 85000,
  purchaseCostMinor: 60000,
  initialStock: 3,
  stock: 3,
};
export const granTurismo = {
  ...product,
  id: ids.granTurismo,
  name: 'Gran Turismo 7 — PS5',
  tipo: 'cantidad',
  unitPriceMinor: 65000,
  purchaseCostMinor: 45000,
  initialStock: 2,
  stock: 2,
};
export const page = (items: unknown[]) => ({
  items,
  total: items.length,
  page: 1,
  limit: 20,
});
export const saleInput = {
  id: ids.sale,
  memberId: ids.carlos,
  deviceId: ids.device,
  occurredAt: createdAt,
  currency: 'MXN',
  cashReceivedMinor: 250000,
  items: [
    { productId: ids.spiderMan, quantity: 1, unitPriceMinor: 125000 },
    { productId: ids.godOfWar, quantity: 1, unitPriceMinor: 85000 },
  ],
};
export const sale = {
  id: ids.sale,
  memberId: ids.carlos,
  deviceId: ids.device,
  occurredAt: createdAt,
  receivedAt: '2026-09-23T12:00:01.000Z',
  currency: 'MXN',
  status: 'completada',
  totalMinor: 210000,
  cashReceivedMinor: 250000,
  changeMinor: 40000,
  requestFingerprint: 'example-sha256-fingerprint-generated-by-server',
  conflictReason: null,
  conflictDetectedAt: null,
  items: [
    {
      id: '41000000-0000-4000-8000-000000000001',
      productId: ids.spiderMan,
      quantity: 1,
      unitPriceMinor: 125000,
      subtotalMinor: 125000,
      createdAt,
    },
    {
      id: '41000000-0000-4000-8000-000000000002',
      productId: ids.godOfWar,
      quantity: 1,
      unitPriceMinor: 85000,
      subtotalMinor: 85000,
      createdAt,
    },
  ],
};
export const rejectedSale = {
  ...sale,
  id: ids.rejectedSale,
  totalMinor: null,
  changeMinor: null,
  status: 'rechazada_por_conflicto',
  items: [],
  conflictReason: `stock insuficiente al sincronizar: producto ${ids.spiderMan}, solicitado 1, disponible 0`,
  conflictDetectedAt: '2026-09-23T12:00:02.000Z',
};
export const incident = {
  id: ids.incident,
  saleId: ids.rejectedSale,
  type: 'conflicto_stock',
  reason: rejectedSale.conflictReason,
  detectedAt: '2026-09-23T12:00:02.000Z',
  resolutionStatus: 'pendiente',
  resolvedByMemberId: null,
  resolvedAt: null,
  resolutionNotes: null,
};
export const resolution = {
  resolutionNotes:
    'Adid contacted the customer; the unavailable Spider-Man 2 copy will not be charged. No automatic inventory change.',
};
export const debtorInput = {
  nombre: 'Lucía (example customer)',
  telefono: 'EXAMPLE-PHONE',
  notas: 'Collect Gran Turismo 7 on Saturday.',
};
export const debtor = { id: ids.debtor, ...debtorInput, contextId, createdAt };
export const debtInput = {
  type: 'apartado',
  productId: ids.granTurismo,
  cantidad: 1,
  deudor: debtorInput,
};
export const debt = {
  id: ids.debt,
  type: 'apartado',
  deudorId: ids.debtor,
  productId: ids.granTurismo,
  cantidad: 1,
  totalMinor: 65000,
  status: 'pendiente',
  createdByMemberId: ids.alberto,
  createdAt,
  abonos: [],
};
export const paymentInput = {
  montoMinor: 20000,
  nota: 'First cash payment collected by Javier.',
};
export const payment = {
  id: ids.payment,
  deudaId: ids.debt,
  ...paymentInput,
  receivedByMemberId: ids.javier,
  receivedAt: '2026-09-23T13:00:00.000Z',
};
export const range = {
  from: '2026-09-20T06:00:00.000Z',
  to: '2026-09-27T05:59:59.999Z',
};
export const commissionItems = [
  {
    memberId: ids.carlos,
    memberName: 'Carlos',
    totalSoldMinor: 210000,
    rateBps: 1000,
    commissionMinor: 21000,
  },
  {
    memberId: ids.javier,
    memberName: 'Javier',
    totalSoldMinor: 0,
    rateBps: 1500,
    commissionMinor: 0,
  },
];
export const fullMember = {
  ...members[2],
  contextId,
  commissionRateBps: 1000,
  createdAt,
};
const {
  id: _productId,
  contextId: _context,
  createdAt: _createdAt,
  image: _image,
  ...snapshot
} = product;
export const audit = {
  id: '90000000-0000-4000-8000-000000000001',
  productId: ids.spiderMan,
  memberId: ids.alberto,
  changedAt: '2026-09-23T12:30:00.000Z',
  oldUnitPriceMinor: 125000,
  newUnitPriceMinor: 120000,
  before: { ...snapshot, imagePath: null },
  after: { ...snapshot, imagePath: null, unitPriceMinor: 120000 },
};
