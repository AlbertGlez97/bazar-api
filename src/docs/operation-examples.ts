import type { ApiBodyOptions, ApiQueryOptions } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import {
  MAX_PASSWORD_LENGTH,
  MIN_NEW_PASSWORD_LENGTH,
} from '../auth/dto/change-password.dto.js';
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
  brand: { ...string('Sony'), nullable: true, maxLength: 40 },
  presentation: {
    ...string('Disc · Spanish'),
    nullable: true,
    maxLength: 40,
    description:
      'Size, measure or capacity ("XL", "24 oz"); the color goes inside ("Azul · 28").',
  },
  description: {
    ...string('Single-player action game.'),
    nullable: true,
    maxLength: 200,
  },
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
  authMe: {
    summary: 'Which member am I bound to?',
    description:
      'Only the bearer token is needed (no x-device-id): call it right after login. Every account belongs to ONE person and can ONLY act as it: memberId and member are that person. They are null only for an account with no person assigned, which cannot enter (403 "Tu cuenta no tiene una persona asignada" on every operational route). A deactivated person is reported with active false. Never returns the context, the account id or any credential.',
    access: 'jwt',
    responses: ok({
      username: 'carlos@example.com',
      memberId: e.ids.carlos,
      member: {
        id: e.ids.carlos,
        name: 'Carlos',
        role: 'colaborador',
        active: true,
      },
    }),
  },
  changePassword: {
    summary: 'Change my own password',
    description: `Any logged-in person (a socio or a colaborador) changes the password of their own account; only the bearer token is needed, no x-device-id. newPassword must have ${MIN_NEW_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters and differ from currentPassword; passwords are used exactly as sent (never trimmed). A wrong currentPassword answers 403, NOT 401, so the session is kept. Answers 204 with no body. Existing tokens stay valid until they expire. Placeholder passwords are not real account secrets.`,
    access: 'jwt',
    body: body(
      {
        currentPassword: {
          ...string('REPLACE_WITH_YOUR_CURRENT_PASSWORD'),
          format: 'password',
          writeOnly: true,
        },
        newPassword: {
          ...string('REPLACE_WITH_A_NEW_PASSWORD'),
          format: 'password',
          writeOnly: true,
          minLength: MIN_NEW_PASSWORD_LENGTH,
          maxLength: MAX_PASSWORD_LENGTH,
        },
      },
      ['currentPassword', 'newPassword'],
      {
        currentPassword: 'REPLACE_WITH_YOUR_CURRENT_PASSWORD',
        newPassword: 'REPLACE_WITH_A_NEW_PASSWORD',
      },
    ),
    responses: [
      {
        status: 204,
        description: 'Password changed. No response body.',
        value: null,
      },
      {
        status: 403,
        description:
          'The current password is incorrect (or the stored hash is unusable). Nothing changed. A request that lost a simultaneous change may also get this, because the other change already replaced the password.',
        value: {
          message: 'Current password is incorrect',
          error: 'Forbidden',
          statusCode: 403,
        },
      },
      {
        status: 409,
        description:
          'Another password change for the same account won a simultaneous race while both verified the same current password; retry with the latest password.',
        value: {
          message:
            'The password was changed by another request; try again with the latest password',
          error: 'Conflict',
          statusCode: 409,
        },
      },
    ],
    errors: [invalid],
  },
  members: {
    summary: 'List Alberto, Adid, Carlos and Javier for selection',
    description:
      'Returns a bare array of id/name/role/active, ordered by name then id. No pagination. People are added with POST /members (socio only).',
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
    summary: 'Identify or activate a device',
    description:
      'Identifier and exact name must match a same-context device. A pending device (POST /devices) is activated ONCE and answers { deviceId, deviceToken }; the token is shown only in that response and must be sent as x-device-token from then on. A used identifier or a revoked device answers 409, wrong credentials 403. A legacy device (created before BE-12) still answers { deviceId } with no token. Does not register a new device.',
    access: 'jwt',
    body: body(
      { identifier: string('shared-tablet'), name: string('Shared tablet') },
      ['identifier', 'name'],
      { identifier: 'shared-tablet', name: 'Shared tablet' },
    ),
    responses: ok({ deviceId: e.ids.device }),
    errors: [
      invalid,
      [403, 'Device is unknown or unauthorized'],
      [
        409,
        'Este identificador ya fue usado. Pide a un socio que te genere uno nuevo.',
      ],
    ],
  },
  productCreate: {
    summary: 'Add a PS5 game to the catalog',
    description:
      'Socio only. unica always starts with stock 1. cantidad requires initialStock. purchaseCostMinor is mandatory; other metadata is optional and can be omitted. Image is uploaded separately. Create also writes an audit.',
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
      ['name', 'tipo', 'unitPriceMinor', 'purchaseCostMinor'],
      e.productInput,
    ),
    responses: ok(e.product, 201),
    errors: [invalid, forbidden],
  },
  productPatch: {
    summary: 'Change Spider-Man 2 price to MXN $1,200.00',
    description:
      'Socio only; at least one field. Cannot patch tipo, stock or initialStock. Nullable metadata may be cleared with null, except purchaseCostMinor: once set it can be corrected but never cleared back to null. Transactional audit records old/new values.',
    access: 'socio',
    id: e.ids.spiderMan,
    body: body(productFields, [], { unitPriceMinor: 120000 }),
    responses: ok({ ...e.product, unitPriceMinor: 120000 }),
    errors: [invalid, forbidden, missing],
  },
  products: {
    summary: 'Search the PS5 catalog',
    description:
      'JWT read access, including colaboradores (who never receive purchaseCostMinor). Optional brand filter (exact, ignoring case). Offset pagination is not a snapshot across requests.',
    access: 'jwt',
    queries: [
      ...pagination,
      search(
        'PS5',
        'Case-insensitive search in the product name, brand and presentation.',
      ),
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
  reportSalesDetail: {
    summary: 'Detailed sales-and-profit breakdown by product and member',
    description:
      'Socio only. One row per (product, member) pair for the period; a row carries a profit figure only when every underlying sale line has a recorded cost — never estimated. Paginated in-memory over the aggregated rows (see page/limit); totals cover the whole period regardless of the requested page.',
    access: 'socio',
    queries: [...dates(true), ...pagination],
    responses: ok({
      items: [
        {
          productId: e.ids.spiderMan,
          productName: 'Marvel’s Spider-Man 2 — PS5',
          productBrand: 'Sony',
          productPresentation: 'Disc · Spanish',
          memberId: e.ids.carlos,
          memberName: 'Carlos',
          units: 2,
          ingresoMinor: 250000,
          costoMinor: 180000,
          gananciaMinor: 70000,
          gananciaDisponible: true,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
      totals: { ingresoMinor: 250000, gananciaMinor: 70000, lineasSinCosto: 0 },
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
    summary: 'Register a brand-new business (the correo is verified before anyone approves it)',
    description:
      'Public, no auth. Validates the Cloudflare Turnstile token on the server (one use, expires), the honeypot field and the data, then creates the request in "pendiente_correo" and emails the applicant a verification link (random 32-byte token stored as a sha256 hash, one use, 48 h). The approver is NOT told anything until the applicant confirms the link (POST /business-registration/verify-email). ALWAYS answers 202 { ok: true } for a well-formed request: a correo that already has a request, a filled honeypot or a reached per-correo limit look exactly like a success. Free texts are untrusted: they are cleaned (no control or invisible characters), length-limited and HTML-escaped wherever shown. The telefono (Mexico: spaces, hyphens and +52 accepted) is stored as 10 digits and is NOT verified. Errors: 400 validation (standard body) or { code: "turnstile_invalid" }; 429 { code: "rate_limited" } with Retry-After (5 requests/hour per IP, taken from CF-Connecting-IP); 503 { code: "turnstile_unavailable" | "email_unavailable" } (nothing is left half done).',
    access: 'public',
    body: body(
      {
        nombreNegocio: { ...string(e.businessRegistrationInput.nombreNegocio), maxLength: 200 },
        tipoNegocio: {
          ...string(
            e.businessRegistrationInput.tipoNegocio,
            'One of: bazar_o_tianguis, abarrotes, ropa_y_accesorios, comida_y_bebidas, plantas_y_jardineria, artesanias, servicios, otro.',
          ),
          enum: [
            'bazar_o_tianguis',
            'abarrotes',
            'ropa_y_accesorios',
            'comida_y_bebidas',
            'plantas_y_jardineria',
            'artesanias',
            'servicios',
            'otro',
          ],
        },
        queVende: { ...string(e.businessRegistrationInput.queVende), minLength: 10, maxLength: 400 },
        dondeVende: { ...string(e.businessRegistrationInput.dondeVende, 'Optional.'), maxLength: 200 },
        recomendadoPor: { ...string(e.businessRegistrationInput.recomendadoPor, 'Optional.'), maxLength: 120 },
        nombre: { ...string(e.businessRegistrationInput.nombre), maxLength: 100 },
        apellidos: { ...string(e.businessRegistrationInput.apellidos), maxLength: 100 },
        correo: {
          ...string(
            e.businessRegistrationInput.correo,
            'A valid email address. Trimmed and stored lower-cased. The emailed link proves it is the applicant\'s.',
          ),
          format: 'email',
          maxLength: 254,
        },
        telefono: string(
          e.businessRegistrationInput.telefono,
          'Required. A Mexican phone: 10 digits, with spaces, hyphens and an optional +52. Stored as 10 digits. Not verified.',
        ),
        aceptaLegal: { type: 'boolean', enum: [true], example: true, description: 'Must be true: accepts the Aviso de privacidad and the Términos.' },
        versionLegal: string(e.businessRegistrationInput.versionLegal, 'YYYY-MM-DD version of the legal texts shown. Stored with the server date.'),
        turnstileToken: { ...string(e.businessRegistrationInput.turnstileToken), maxLength: 2048 },
        sitioWebEmpresa: { ...string('', 'Honeypot: people never see it. Leave empty; if filled the request is silently ignored.'), maxLength: 500 },
      },
      [
        'nombreNegocio',
        'tipoNegocio',
        'queVende',
        'nombre',
        'apellidos',
        'correo',
        'telefono',
        'aceptaLegal',
        'versionLegal',
        'turnstileToken',
      ],
      e.businessRegistrationInput,
    ),
    responses: ok(e.businessRegistration, 202, 'Always this body for a well-formed request.'),
    errors: [invalid, [429, 'Too many attempts from this IP (Retry-After header).'], [503, 'Turnstile or the verification email is unavailable; nothing was created.']],
  },
  businessRegistrationVerifyEmail: {
    summary: 'Confirm the correo (button on the frontend page /verificar-correo)',
    description:
      'Public, no auth. POST, never GET: mail scanners open links on their own and would confirm someone else\'s address. Consumes the one-use token (atomic), moves the request to "pendiente" and only now emails the approver. An unknown, used or expired token all answer the same 400 { code: "link_invalid" }. If the approver email fails everything rolls back (503) and the same link still works. 10 verifications/hour per IP (429).',
    access: 'public',
    body: body(
      { token: { ...string(e.businessRegistrationVerifyInput.token), minLength: 20, maxLength: 200 } },
      ['token'],
      e.businessRegistrationVerifyInput,
    ),
    responses: ok({ ok: true }, 200),
    errors: [[400, 'link_invalid: the link expired, was already used or does not exist.'], [429, 'Too many attempts from this IP.'], [503, 'The approver email could not be sent; retry.']],
  },
  businessRegistrationResend: {
    summary: 'Resend the verification link',
    description:
      'Public, no auth. ALWAYS 202 { ok: true }, whether the correo exists or not. Only a "pendiente_correo" request gets a new link (a new token; the old one stops working), at most once every 60 s and 3 emails per request in total (the first counts), and 3 per hour per correo. 10 resends/hour per IP (429).',
    access: 'public',
    body: body(
      { correo: { ...string(e.businessRegistrationResendInput.correo), format: 'email', maxLength: 254 } },
      ['correo'],
      e.businessRegistrationResendInput,
    ),
    responses: ok({ ok: true }, 202),
    errors: [invalid, [429, 'Too many attempts from this IP.'], [503, 'The email could not be sent.']],
  },
  businessRegistrationApprove: {
    summary: 'Approve a pending business registration (link from the email)',
    description:
      'Public, no auth — meant to be opened directly from the approval email by a human, so every outcome renders a plain HTML status page instead of a JSON error, and returns 200 even for "already processed"/"expired" (only a missing/unrecognized token is 404). Approving, in one transaction, creates the real contextId, the founding socio Member, the socio login Account (random temporary password, stored only as an Argon2id hash) and one authorized "Dispositivo principal" Device, then emails the credentials (username, temporary password, device identifier) to the correo registered for the socio, or to the approver (to relay) for a legacy request that has no usable correo. While Resend runs in test mode (no verified domain) it rejects any recipient but the account owner; only for that exact rejection the same credentials are forwarded to the approver as an explicit backup and the approval still succeeds (the page says so). If that email cannot be sent (any other Resend error, a failed backup, or no answer within the 10 s total deadline shared by the direct send and the backup), if the transaction times out, or if a concurrent approval takes the same username first, everything rolls back, the request stays "pendiente" and the response is 502 so the same link can be retried. The password is never shown on the page.',
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
        status: 200,
        description:
          'Valid token, but Resend (test mode) refused the socio address: the credentials were forwarded to the approver as a backup and must be relayed manually. The approval itself is complete.',
        value:
          '<html>...<h1>Negocio aprobado</h1><p>El negocio "Bonsáis de Alberto" fue aprobado. Resend (en modo de prueba) no permitió enviar las credenciales de acceso a alberto@example.com, así que se enviaron al correo del aprobador como reenvío de respaldo: hazlas llegar al socio.</p>...</html>',
      },
      {
        status: 502,
        description:
          'The credentials email could not be sent: nothing was created, the request is still pending and the same link can be used again.',
        value:
          '<html>...<h1>No se pudo enviar el correo de credenciales</h1><p>La aprobación no se completó y la solicitud sigue pendiente. Vuelve a abrir este mismo enlace para reintentarlo.</p>...</html>',
      },
      {
        status: 502,
        description:
          'The approval transaction timed out: nothing was created, the request is still pending and the same link can be used again.',
        value:
          '<html>...<h1>La aprobación tardó demasiado</h1><p>Se agotó el tiempo de la operación. La aprobación no se completó y la solicitud sigue pendiente. Vuelve a abrir este mismo enlace para reintentarlo.</p>...</html>',
      },
      {
        status: 502,
        description:
          'A concurrent approval took the same username first: nothing was created, the request is still pending and the retry with the same link derives a fresh username.',
        value:
          '<html>...<h1>No se pudo crear el usuario</h1><p>Otro registro tomó el mismo nombre de usuario al mismo tiempo. La aprobación no se completó y la solicitud sigue pendiente. Vuelve a abrir este mismo enlace para reintentarlo.</p>...</html>',
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
