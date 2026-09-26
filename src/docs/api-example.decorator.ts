import { applyDecorators } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import { operations, type OperationName } from './operation-examples.js';
import { ids } from './bazaar-examples.js';

/** Example-derived response shapes are documentation only, never validators. */
export function exampleSchema(value: unknown): SchemaObject {
  if (value === null) return { nullable: true, example: null };
  if (Array.isArray(value))
    return {
      type: 'array',
      items: value.length ? exampleSchema(value[0]) : {},
      example: value,
    };
  if (typeof value === 'object' && value !== null) {
    return {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, exampleSchema(item)]),
      ),
      example: value,
    };
  }
  return {
    type: typeof value === 'number' ? 'integer' : typeof value,
    example: value,
  };
}

/** Shared documentation metadata; does not add guards or change runtime behavior. */
export function ApiExample(name: OperationName) {
  const operation = operations[name];
  const decorators = [
    ApiOperation({
      summary: operation.summary,
      description: `${operation.description}\n\nExamples are fictional, not seeded records. Replace UUIDs with values from your installation. All *Minor amounts are integer MXN cents: 125000 = MXN $1,250.00.`,
    }),
  ];
  if (name === 'root') decorators.push(ApiTags('application'));
  if (operation.access !== 'public') {
    decorators.push(
      ApiBearerAuth(),
      ApiResponse({
        status: 401,
        description: 'Missing, expired or invalid bearer token.',
        schema: exampleSchema({ message: 'Unauthorized', statusCode: 401 }),
      }),
    );
  }
  if (operation.access === 'socio' || operation.access === 'context') {
    decorators.push(
      ApiHeader({
        name: 'x-member-id',
        required: true,
        schema: {
          type: 'string',
          format: 'uuid',
          example: operation.actor ?? ids.alberto,
        },
        description:
          operation.access === 'socio'
            ? 'Select Alberto or Adid (socio). Shared-tablet selection, not personal authentication.'
            : 'Selected member (socio or colaborador); must match sale body memberId when present.',
      }),
      ApiHeader({
        name: 'x-device-id',
        required: true,
        schema: { type: 'string', format: 'uuid', example: ids.device },
        description:
          'Authorized same-context deviceId returned by POST /devices/identify.',
      }),
      ApiHeader({
        name: 'x-device-token',
        required: false,
        schema: { type: 'string' },
        description:
          'Required only for a device activated through the one-time activation flow, which receives this secret once; ignored for a legacy device.',
      }),
    );
  }
  if (operation.id)
    decorators.push(
      ApiParam({
        name: 'id',
        type: String,
        format: 'uuid',
        example: operation.id,
        description:
          'Existing same-context resource UUID; example is fictional.',
      }),
    );
  for (const query of operation.queries ?? []) decorators.push(ApiQuery(query));
  if (operation.body) {
    decorators.push(ApiBody(operation.body));
  }
  if (operation.multipart) decorators.push(ApiConsumes('multipart/form-data'));
  // OpenAPI keys responses by status code and Nest keeps only the last
  // ApiResponse per status, so operations that document several outcomes with
  // the same status (e.g. the approve page has three 200s and two 502s) are
  // grouped here into ONE response carrying a named example per outcome.
  const byStatus = new Map<number, typeof operation.responses>();
  for (const response of operation.responses)
    byStatus.set(response.status, [
      ...(byStatus.get(response.status) ?? []),
      response,
    ]);
  for (const [status, group] of byStatus) {
    const [first] = group;
    const media =
      group.length === 1
        ? { schema: exampleSchema(first.value), example: first.value }
        : {
            schema: group.every((r) => typeof r.value === 'string')
              ? { type: 'string' as const }
              : { oneOf: group.map((r) => exampleSchema(r.value)) },
            examples: Object.fromEntries(
              group.map((r, index) => [
                `outcome${index + 1}`,
                { summary: r.description, value: r.value },
              ]),
            ),
          };
    decorators.push(
      ApiResponse({
        status,
        description: group.map((r) => r.description).join('\n\n'),
        content: { [operation.contentType ?? 'application/json']: media },
      }),
    );
  }
  for (const [status, message] of operation.errors ?? []) {
    const error = (
      {
        400: 'Bad Request',
        401: 'Unauthorized',
        403: 'Forbidden',
        404: 'Not Found',
        409: 'Conflict',
        413: 'Payload Too Large',
      } as Record<number, string>
    )[status];
    decorators.push(
      ApiResponse({
        status,
        description: message,
        schema: exampleSchema({
          message: status === 400 ? ['property unexpectedField should not exist']
            : status === 403 ? 'Selection is not authorized for this context' : message,
          error, statusCode: status,
        }),
      }),
    );
  }
  return applyDecorators(...decorators);
}
