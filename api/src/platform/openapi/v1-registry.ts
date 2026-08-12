/**
 * v1 OpenAPI registry — the single source of truth for the PUBLIC /api/v1 spec.
 *
 * This is deliberately SEPARATE from api/src/openapi/registry.ts. That one
 * documents the INTERNAL /api surface and registers schemas in a parallel
 * directory that the routes themselves never import, so a route can change
 * without the spec noticing — drift is structurally possible there.
 *
 * Here the flow is inverted: nothing registers into this registry directly.
 * The route factory (route-factory.ts) is the ONLY writer, and it registers
 * the OpenAPI operation and mounts the Express handler in the same call. A
 * route that exists is in the spec; a spec entry that exists is a route. The
 * fitness tests assert that invariant against `v1RouteCatalog`.
 *
 * Week 6 brief: "the spec is GENERATED FROM ROUTE METADATA, never hand-written".
 */
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import { API_ERROR_CODES } from '../api/v1/errors.js';
import type { RegisteredRoute } from './route-factory.js';

// Must run before any `.openapi()` call on a Zod schema in this subtree. The
// call is idempotent (the library no-ops if the prototype is already
// extended), so co-existing with the internal registry's call is safe.
extendZodWithOpenApi(z);

/** The public v1 registry. Written to exclusively by the route factory. */
export const v1Registry = new OpenAPIRegistry();

v1Registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description:
    'OAuth 2.0 access token issued by Ship, sent as `Authorization: Bearer <token>`. ' +
    'Every operation additionally declares the scope it requires in `x-required-scope`.',
});

/**
 * The one error envelope every v1 failure ships (api/v1/errors.ts).
 *
 * The `code` enum is derived from API_ERROR_CODES rather than restated, so a
 * new error code cannot exist in the runtime and be missing from the spec.
 */
export const ApiErrorSchema = v1Registry.register(
  'ApiError',
  z
    .object({
      code: z.enum(API_ERROR_CODES),
      message: z.string(),
      details: z.record(z.unknown()).optional(),
      request_id: z.string(),
    })
    .openapi('ApiError')
);

/**
 * Machine-readable manifest of every registered v1 route.
 *
 * This is what the fitness tests and the SDK-parity test consume: it is
 * populated by the route factory at definition time, so it cannot describe a
 * route that was never mounted, and no route can be mounted without appearing
 * here.
 */
export const v1RouteCatalog: RegisteredRoute[] = [];

const DESCRIPTION = [
  'The Ship public API. Every endpoint is OAuth 2.0 bearer-authenticated and',
  'scope-gated; the required scope for an operation is published as the',
  '`x-required-scope` extension on that operation.',
  '',
  'Failures always use one envelope: `{ code, message, details?, request_id }`',
  '(see the `ApiError` schema). `request_id` correlates the response with the',
  'audit log and webhook delivery log.',
  '',
  'List endpoints are cursor-paginated: they return `{ data, next_cursor }`,',
  'where a null `next_cursor` means the last page.',
  '',
  'This document is generated from route metadata at build time — it is never',
  'hand-written and cannot drift from the mounted router.',
].join('\n');

/** Generate the OpenAPI 3.1 document from everything the route factory registered. */
export function buildV1Spec(): OpenAPIObject {
  const generator = new OpenApiGeneratorV31(v1Registry.definitions);

  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Ship Public API',
      version: '1.0.0',
      description: DESCRIPTION,
    },
    servers: [{ url: '/api/v1' }],
  });
}
