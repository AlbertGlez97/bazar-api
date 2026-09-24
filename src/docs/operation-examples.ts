import type { ApiBodyOptions, ApiQueryOptions } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import * as e from './bazaar-examples.js';

type Operation = {
  summary: string;
  description: string;
  access: 'public' | 'jwt' | 'context' | 'socio';
  actor?: string;
  id?: string;
  queries?: ApiQueryOptions[];
  body?: ApiBodyOptions;
  multipart?: boolean;
  responses: { status: number; description: string; value: unknown }[];
  errors?: [number, string][];
  // Defaults to 'application/json'. Set 'text/html' for endpoints that
  // render a page instead of returning JSON (see 'root' and the
  // business-registration approve/reject status pages, BE-11) — the
  // response `value` is then rendered as a raw string example instead of
  // an object schema.
  contentType?: 'application/json' | 'text/html';
};
const string = (example: string, description?: string): SchemaObject => ({
  type: 'string',
  example,
  description,
});
const uuid = (example: string): SchemaObject => ({
  ...string(example),
  format: 'uuid',
});
const money = (example: number): SchemaObject => ({
  type: 'integer',
  minimum: 0,
  maximum: 2147483647,
  example,
  description: 'Integer MXN cents; 125000 = MXN $1,250.00. Fractions rejected.',
});
const body = (
  properties: Record<string, SchemaObject>,
  required: string[],
  example: unknown,
  description?: string,
): ApiBodyOptions => ({
  required: true,
  description,
  schema: { type: 'object', additionalProperties: false, properties, required },
  examples: {
    ps5Bazaar: { summary: 'Fictional PS5 bazaar request', value: example },
  },
});
const ok = (
  value: unknown,
  status = 200,
  description = 'Successful response; no extra data wrapper.',
) => [{ status, description, value }];
const forbidden: [number, string] = [
  403,
  'Forbidden: selected member/device is unauthorized, outside the account context, or not a socio for this operation.',
];
const invalid: [number, string] = [
  400,
  'Validation failed: check required fields, integer cents, UUIDs and unknown properties.',
];
const missing: [number, string] = [404, 'Not Found'];
const pagination: ApiQueryOptions[] = [
  {
    name: 'page',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 1000000, default: 1 },
    example: 1,
  },
  {
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    example: 20,
  },
];
const search = (example: string, description: string): ApiQueryOptions => ({
  name: 'search',
  required: false,
  type: String,
  example,
  description,
});
const sort: ApiQueryOptions = {
  name: 'sort',
  required: false,
  enum: ['asc', 'desc'],
  example: 'desc',
  description: 'Timestamp ordering; UUID breaks ties. Default desc.',
};
const filter = (name: string, values: string[]): ApiQueryOptions => ({
  name,
  required: false,
  enum: values,
  example: values[0],
});
const dates = (required: boolean): ApiQueryOptions[] =>
  ['from', 'to'].map((name, i) => ({
    name,
    required,
    type: String,
    example: i ? '2026-09-26' : '2026-09-20',
    description:
      'Date-only business day (UTC-06:00) or ISO-8601 instant. Inclusive boundary, based on receivedAt.',
  }));
const metadata: Record<string, SchemaObject> = {
  category: { ...string('PS5 physical games'), nullable: true },
  purchaseCostMinor: { ...money(90000), nullable: true },
  supplier: { ...string('Local trade-in'), nullable: true },
  notes: { ...string('Used disc and original case, tested.'), nullable: true },
};
const productFields = {
  name: string(e.productInput.name),
  unitPriceMinor: money(125000),
  ...metadata,
};
const rate = {
  type: 'integer',
  minimum: 0,
  maximum: 10000,
  example: 1000,
  description: 'Basis points: 1000 = 10%, 1500 = 15%.',
} satisfies SchemaObject;
const saleFields: Record<string, SchemaObject> = {
  id: uuid(e.ids.sale),
  memberId: uuid(e.ids.carlos),
  deviceId: uuid(e.ids.device),
  occurredAt: { ...string(e.createdAt), format: 'date-time' },
  currency: { type: 'string', enum: ['MXN'] },
  cashReceivedMinor: money(250000),
  items: {
    type: 'array',
    minItems: 1,
    maxItems: 500,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['productId', 'quantity'],
      properties: {
        productId: uuid(e.ids.spiderMan),
        quantity: { type: 'integer', minimum: 1, maximum: 100000, example: 1 },
        unitPriceMinor: {
          ...money(125000),
          description:
            'Optional client price; ignored for pricing and replay identity. Server charges current catalog price.',
        },
      },
    },
  },
};
const debtorFields: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['nombre'],
  properties: {
    nombre: string(e.debtorInput.nombre),
    telefono: string(
      'EXAMPLE-PHONE',
      'Optional fictional placeholder, not a real phone number.',
    ),
    notas: string(e.debtorInput.notas),
  },
};

export const operations: Record<string, Operation> = {
  root: {
    summary: 'Read the original application greeting',
    description: 'Public greeting, not a database readiness probe.',
    access: 'public',
    contentType: 'text/html',
    responses: ok('Hello World!'),
  },
  login: {
    summary: 'Log in to the shared bazaar account',
    description:
      'Returns a 12-hour JWT. Use Swagger Authorize with accessToken; do not paste documentation Basic credentials. Placeholder password is not a real account secret.',
    access: 'public',
    body: body(
      {
        username: string('ps5-bazaar-example'),
        password: {
          ...string('REPLACE_WITH_YOUR_ACCOUNT_PASSWORD'),
          format: 'password',
          writeOnly: true,
        },
      },
      ['username', 'password'],
      {
        username: 'ps5-bazaar-example',
        password: 'REPLACE_WITH_YOUR_ACCOUNT_PASSWORD',
      },
    ),
    responses: ok({
      accessToken: '<JWT_FROM_LOGIN>',
      tokenType: 'Bearer',
      expiresIn: 43200,
    }),
    errors: [invalid, [401, 'Invalid credentials']],
  },
  members: {
    summary: 'List Alberto, Adid, Carlos and Javier for selection',
    description:
      'Returns a bare array of id/name/role, ordered by name then id. No pagination. No member creation endpoint.',
    access: 'jwt',
    responses: ok(e.members),
  },
  memberRate: {
    summary: 'Set Carlos’s individual commission rate',
    description:
      'Socio only. rateBps 1000 means 10%; null clears the override. Target must be a colaborador. Returns the full updated Member.',
    access: 'socio',
    id: e.ids.carlos,
    body: body({ rateBps: { ...rate, nullable: true } }, ['rateBps'], {
      rateBps: 1000,
    }),
    responses: ok(e.fullMember),
    errors: [invalid, forbidden, missing],
  },
  device: {
    summary: 'Identify the authorized shared tablet',
    description:
      'Both identifier and name must match an already-authorized same-context device. Does not register a new device.',
    access: 'jwt',
    body: body(
      { identifier: string('shared-tablet'), name: string('Shared tablet') },
      ['identifier', 'name'],
      { identifier: 'shared-tablet', name: 'Shared tablet' },
    ),
    responses: ok({ deviceId: e.ids.device }),
    errors: [invalid, [403, 'Device is unknown or unauthorized']],
  },
  productCreate: {
    summary: 'Add a PS5 game to the catalog',
    description:
      'Socio only. unica always starts with stock 1. cantidad requires initialStock. Optional metadata can be omitted; image is uploaded separately. Create also writes an audit.',
    access: 'socio',
    body: body(
      {
        ...productFields,
        tipo: { type: 'string', enum: ['unica', 'cantidad'] },
        initialStock: {
          type: 'integer',
          minimum: 0,
          maximum: 2147483647,
          example: 1,
          description:
            'Required for cantidad; optional and forced to 1 for unica.',
        },
      },
      ['name', 'tipo', 'unitPriceMinor'],
      e.productInput,
    ),
    responses: ok(e.product, 201),
    errors: [invalid, forbidden],
  },
  productPatch: {
    summary: 'Change Spider-Man 2 price to MXN $1,200.00',
    description:
      'Socio only; at least one field. Cannot patch tipo, stock or initialStock. Nullable metadata may be cleared with null. Transactional audit records old/new values.',
    access: 'socio',
    id: e.ids.spiderMan,
    body: body(productFields, [], { unitPriceMinor: 120000 }),
    responses: ok({ ...e.product, unitPriceMinor: 120000 }),
    errors: [invalid, forbidden, missing],
  },
  products: {
    summary: 'Search the PS5 catalog',
    description:
      'JWT read access, including colaboradores. Offset pagination is not a snapshot across requests.',
    access: 'jwt',
    queries: [
      ...pagination,
      search('PS5', 'Case-insensitive product name search.'),
    ],
    responses: ok(e.page([e.product, e.godOfWar, e.granTurismo])),
    errors: [invalid],
  },
  productAudit: {
    summary: 'Read the Spider-Man 2 price audit',
    description:
      'JWT read access. before/after are stored snapshots, including internal imagePath, not the product response image URL. search is accepted by the shared DTO but not used by audit listing.',
    access: 'jwt',
    id: e.ids.spiderMan,
    queries: [
      ...pagination,
      search('', 'Accepted but ignored for audit history.'),
    ],
    responses: ok(e.page([e.audit])),
    errors: [invalid, missing],
  },
  productImage: {
    summary: 'Upload a real PS5 cover image',
    description:
      'Socio only. One multipart file named image, no other form fields, maximum 5 MiB. Actual PNG/JPEG/WebP content must match MIME; decoded image must be single-frame and at most 16 million pixels. Stored as PNG; resulting image URL is public without JWT.',
    access: 'socio',
    id: e.ids.spiderMan,
    multipart: true,
    body: {
      required: true,
      schema: {
        type: 'object',
        required: ['image'],
        properties: {
          image: {
            type: 'string',
            format: 'binary',
            description: 'Select an actual PNG, JPEG or WebP file.',
          },
        },
      },
    },
    responses: ok(
      {
        ...e.product,
        image: '/uploads/products/91000000-0000-4000-8000-000000000001.png',
      },
      201,
    ),
    errors: [invalid, forbidden, missing, [413, 'Payload Too Large']],
  },
  saleCreate: {
    summary: 'Carlos sells Spider-Man 2 and God of War Ragnarök',
    description:
      'Selected member/device must match body. Catalog total 210000 cents ($2,100), cash 250000 ($2,500), change 40000 ($400). New completed or conflict-rejected row:201; normalized replay:200; changed payload:409. Empty stock on initial read:400. No partial stock changes.',
    access: 'context',
    actor: e.ids.carlos,
    body: body(saleFields, Object.keys(saleFields), e.saleInput),
    responses: [
      ...ok(
        e.sale,
        201,
        'New completed sale. A new stock-conflict rejection also uses201; inspect status.',
      ),
      ...ok(e.sale, 200, 'Identical replay; no stock is deducted again.'),
    ],
    errors: [
      invalid,
      forbidden,
      [409, `Sale ${e.ids.sale} already exists with different data`],
    ],
  },
  sales: {
    summary: 'Browse Carlos’s sales and offline conflicts',
    description:
      'Socio only. Search uses selling Member name. Inspect status: conflict rows have null total/change and no persisted SaleItems.',
    access: 'socio',
    queries: [
      ...pagination,
      search('Carlos', 'Case-insensitive selling member name.'),
      sort,
      filter('status', ['completada', 'rechazada_por_conflicto']),
    ],
    responses: ok(e.page([e.sale])),
    errors: [invalid, forbidden],
  },
  saleDetail: {
    summary: 'Retrieve a known sale or rejected conflict',
    description:
      'JWT access within account context. A known sale is readable by any authenticated account in that context, not only its seller.',
    access: 'jwt',
    id: e.ids.sale,
    responses: ok(e.sale),
    errors: [invalid, missing],
  },
  incidents: {
    summary: 'List stock/date incidents for socio review',
    description:
      'Socio only. List items do not embed sale. No automatic refund or stock reassignment.',
    access: 'socio',
    queries: [
      ...pagination,
      search(
        'Carlos',
        'Case-insensitive selling member name, not resolver name.',
      ),
      sort,
      filter('type', ['conflicto_stock', 'incidencia_fecha']),
      filter('resolutionStatus', ['pendiente', 'resuelta']),
    ],
    responses: ok(e.page([e.incident])),
    errors: [invalid, forbidden],
  },
  incidentDetail: {
    summary: 'Read an incident and its related sale',
    description:
      'Socio only. Detail embeds the related sale, including its items.',
    access: 'socio',
    id: e.ids.incident,
    responses: ok({ ...e.incident, sale: e.rejectedSale }),
    errors: [invalid, forbidden, missing],
  },
  incidentResolve: {
    summary: 'Adid records a manual incident resolution',
    description:
      'Socio only. Required resolutionNotes; cannot resolve twice. Updates incident tracking only, not inventory or the sale.',
    access: 'socio',
    actor: e.ids.adid,
    id: e.ids.incident,
    body: body(
      {
        resolutionNotes: {
          ...string(e.resolution.resolutionNotes),
          minLength: 1,
          maxLength: 2000,
        },
      },
      ['resolutionNotes'],
      e.resolution,
    ),
    responses: ok({
      ...e.incident,
      resolutionStatus: 'resuelta',
      resolvedByMemberId: e.ids.adid,
      resolvedAt: '2026-09-23T14:00:00.000Z',
      ...e.resolution,
    }),
    errors: [
      invalid,
      forbidden,
      missing,
      [409, `Incidencia ${e.ids.incident} is already resolved`],
    ],
  },
  commissions: {
    summary: 'Calculate Carlos and Javier’s weekly commissions',
    description:
      'Socio only. Both dates or neither (current Sunday–Saturday week). Completed sales only; pending incidents do not exclude a completed sale. Global rate defaults to0; individual override wins. Half-up cents rounding. Calculation only, not payment.',
    access: 'socio',
    queries: [
      ...dates(false),
      {
        name: 'memberId',
        required: false,
        type: String,
        format: 'uuid',
        example: e.ids.carlos,
        description:
          'Optional: filter to one colaborador. Omit to get both example rows.',
      },
    ],
    responses: ok({ ...e.range, items: e.commissionItems }),
    errors: [invalid, forbidden, missing],
  },
  settings: {
    summary: 'Alberto sets the default commission to 10%',
    description:
      'Socio only. Applies when the colaborador has no individual override. Returns AppSettings directly.',
    access: 'socio',
    body: body({ rateBps: rate }, ['rateBps'], { rateBps: 1000 }),
    responses: ok({
      contextId: e.contextId,
      defaultCommissionRateBps: 1000,
      updatedAt: e.createdAt,
    }),
    errors: [invalid, forbidden],
  },
  reportPeriod: {
    summary: 'Report completed PS5 sales for a period',
    description:
      'Socio only. Sums completed Sale totals by receivedAt; debt payments are not sales. Returns inclusive normalized date boundaries.',
    access: 'socio',
    queries: dates(true),
    responses: ok({ ...e.range, totalSoldMinor: 210000, saleCount: 1 }),
    errors: [invalid, forbidden],
  },
  reportMember: {
    summary: 'Report completed sales by selling member',
    description:
      'Socio only. Includes socios/colaboradores with completed sales; members with no sales are omitted. Not a paginated response.',
    access: 'socio',
    queries: dates(true),
    responses: ok({
      ...e.range,
      items: [
        {
          memberId: e.ids.carlos,
          memberName: 'Carlos',
          role: 'colaborador',
          totalSoldMinor: 210000,
        },
      ],
    }),
    errors: [invalid, forbidden],
  },
  debtCreate: {
    summary: 'Alberto reserves Gran Turismo 7 as an apartado',
    description:
      'Socio only. One product/cantidad; both fiado and apartado deduct stock immediately. Exactly one deudorId or inline deudor; server calculates65000 cents ($650). Create response includes abonos but NOT the nested deudor object.',
    access: 'socio',
    body: body(
      {
        type: { type: 'string', enum: ['fiado', 'apartado'] },
        productId: uuid(e.ids.granTurismo),
        cantidad: { type: 'integer', minimum: 1, maximum: 100000, example: 1 },
        deudorId: uuid(e.ids.debtor),
        deudor: debtorFields,
      },
      ['type', 'productId', 'cantidad'],
      e.debtInput,
      'Supply exactly one of deudorId or deudor.',
    ),
    responses: ok(e.debt, 201),
    errors: [invalid, forbidden],
  },
  debts: {
    summary: 'Find Lucía’s pending fiado/apartado debts',
    description:
      'Socio only. Search matches debtor name, not selling member. List embeds deudor and abonos. No computed remaining-balance field is returned.',
    access: 'socio',
    queries: [
      ...pagination,
      search('Lucía', 'Case-insensitive debtor nombre.'),
      sort,
      filter('status', ['pendiente', 'saldada']),
    ],
    responses: ok(e.page([{ ...e.debt, deudor: e.debtor }])),
    errors: [invalid, forbidden],
  },
  debtDetail: {
    summary: 'Read a debt and its payment history',
    description:
      'Socio only. Response embeds deudor and abonos; totalMinor remains the original debt amount.',
    access: 'socio',
    id: e.ids.debt,
    responses: ok({ ...e.debt, deudor: e.debtor }),
    errors: [invalid, forbidden, missing],
  },
  debtPayment: {
    summary: 'Javier collects a MXN $200 payment',
    description:
      'Any selected socio/colaborador may collect. montoMinor20000 against65000 leaves45000 cents; response has no saldo field. No overpayment; saldada is derived once fully covered. Returns updated debt, not a standalone payment.',
    access: 'context',
    actor: e.ids.javier,
    id: e.ids.debt,
    body: body(
      {
        montoMinor: { ...money(20000), minimum: 1 },
        nota: { ...string(e.paymentInput.nota), maxLength: 2000 },
      },
      ['montoMinor'],
      e.paymentInput,
    ),
    responses: ok({ ...e.debt, deudor: e.debtor, abonos: [e.payment] }, 201),
    errors: [invalid, forbidden, missing],
  },
  // BE-11: public business-registration form + email-approval flow. See
  // doc/reglas-de-negocio.md's "Registro de negocio (BE-11)" section for
  // the full rationale (hashed single-use token, 30-day expiry, no
  // operational contextId/Member until approved).
  businessRegistrationCreate: {
    summary: 'Register a brand-new business for approval',
    description:
      'Public, no auth. Creates a SolicitudNegocio in "pendiente" status and emails the fixed approval recipient (APPROVAL_NOTIFICATION_EMAIL) with one-time approve/reject links (30-day expiry, tokens stored hashed). No contextId or Member exists yet; those are only created if/when the approve link is followed.',
    access: 'public',
    body: body(
      {
        nombreNegocio: string(e.businessRegistrationInput.nombreNegocio),
        nombreSocio: string(e.businessRegistrationInput.nombreSocio),
        contactoSocio: string(
          e.businessRegistrationInput.contactoSocio,
          'Email or phone; either is accepted, only non-empty is required.',
        ),
      },
      ['nombreNegocio', 'nombreSocio', 'contactoSocio'],
      e.businessRegistrationInput,
    ),
    responses: ok(e.businessRegistration, 201),
    errors: [invalid],
  },
  businessRegistrationApprove: {
    summary: 'Approve a pending business registration (link from the email)',
    description:
      'Public, no auth — meant to be opened directly from the approval email by a human, so every outcome renders a plain HTML status page instead of a JSON error, and returns 200 even for "already processed"/"expired" (only a missing/unrecognized token is 404). Approving, in one transaction, creates the real contextId, the founding socio Member, the socio login Account (random temporary password, stored only as an Argon2id hash) and one authorized "Dispositivo principal" Device, then emails the credentials (username, temporary password, device identifier) to the socio when contactoSocio is an email, or to the approver (to relay) when it is not. If that email cannot be sent, everything rolls back, the request stays "pendiente" and the response is 502 so the same link can be retried. The password is never shown on the page.',
    access: 'public',
    contentType: 'text/html',
    queries: [
      {
        name: 'token',
        required: true,
        type: String,
        example: 'example-raw-token-from-the-emailed-link',
        description:
          'Raw, single-use token from the email link; only its hash is ever stored.',
      },
    ],
    responses: [
      {
        status: 200,
        description:
          'Valid, unused, unexpired token: business approved and credentials emailed.',
        value:
          '<html>...<h1>Negocio aprobado</h1><p>El negocio "Bonsáis de Alberto" fue aprobado. Las credenciales de acceso (usuario, contraseña temporal e identificador del dispositivo) se enviaron por correo a alberto@example.com.</p>...</html>',
      },
      {
        status: 502,
        description:
          'The credentials email could not be sent: nothing was created, the request is still pending and the same link can be used again.',
        value:
          '<html>...<h1>No se pudo enviar el correo de credenciales</h1><p>La aprobación no se completó y la solicitud sigue pendiente. Vuelve a abrir este mismo enlace para reintentarlo.</p>...</html>',
      },
      {
        status: 200,
        description: 'Token already used previously; nothing is duplicated.',
        value:
          '<html>...<h1>Ya fue procesado</h1><p>Esta solicitud ya fue resuelta anteriormente; este enlace ya no tiene efecto.</p>...</html>',
      },
      {
        status: 200,
        description: 'Token expired (30 days since the request was created).',
        value:
          '<html>...<h1>El enlace expiró</h1><p>Este enlace de aprobación/rechazo ya expiró (30 días).</p>...</html>',
      },
      {
        status: 404,
        description: 'Missing or unrecognized token.',
        value:
          '<html>...<h1>Enlace inválido</h1><p>Este enlace no corresponde a ninguna solicitud.</p>...</html>',
      },
    ],
  },
  businessRegistrationReject: {
    summary: 'Reject a pending business registration (link from the email)',
    description:
      'Public, no auth; same token validation and HTML-status-page behavior as the approve endpoint. Rejecting only marks the request "rechazado" — no contextId or Member is ever created.',
    access: 'public',
    contentType: 'text/html',
    queries: [
      {
        name: 'token',
        required: true,
        type: String,
        example: 'example-raw-token-from-the-emailed-link',
        description:
          'Raw, single-use token from the email link; only its hash is ever stored.',
      },
    ],
    responses: [
      {
        status: 200,
        description: 'Valid, unused, unexpired token: request rejected.',
        value:
          '<html>...<h1>Solicitud rechazada</h1><p>La solicitud de "Bonsáis de Alberto" fue rechazada. No se creó nada.</p>...</html>',
      },
      {
        status: 200,
        description: 'Token already used previously; nothing is duplicated.',
        value:
          '<html>...<h1>Ya fue procesado</h1><p>Esta solicitud ya fue resuelta anteriormente; este enlace ya no tiene efecto.</p>...</html>',
      },
      {
        status: 200,
        description: 'Token expired (30 days since the request was created).',
        value:
          '<html>...<h1>El enlace expiró</h1><p>Este enlace de aprobación/rechazo ya expiró (30 días).</p>...</html>',
      },
      {
        status: 404,
        description: 'Missing or unrecognized token.',
        value:
          '<html>...<h1>Enlace inválido</h1><p>Este enlace no corresponde a ninguna solicitud.</p>...</html>',
      },
    ],
  },
};
export type OperationName = keyof typeof operations;
