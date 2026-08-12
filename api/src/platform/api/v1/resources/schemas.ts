/**
 * Zod schemas for the public v1 surface.
 *
 * These live adjacent to the handlers that use them (not in a parallel schema
 * directory) because the route factory registers the SAME schema object into
 * the OpenAPI document that the handler validates against — that shared object
 * is what makes spec drift structurally impossible.
 */
import { z } from 'zod';

/** The document types the public API exposes. Ship's internal model has more
 * (standups, weekly plans/retros/reviews); v1 publishes the three the SDK's
 * resource clients cover, so the contract stays small and honest. */
export const PUBLIC_DOCUMENT_TYPES = ['wiki', 'issue', 'sprint'] as const;

export const ShipUserSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    name: z.string(),
    workspace_id: z.string().uuid().nullable(),
    client_id: z.string().nullable().openapi({
      description: 'The OAuth app this token belongs to, or null for a personal access token.',
    }),
    scopes: z.array(z.string()),
  })
  .openapi('User');

export const DocumentSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    document_type: z.string(),
    state: z.string().nullable().openapi({ description: "Issue workflow state, when applicable." }),
    ticket_number: z.number().int().nullable(),
    parent_id: z.string().uuid().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('Document');

export const IssueSchema = DocumentSchema.extend({
  assignee_id: z.string().uuid().nullable(),
  priority: z.string().nullable(),
}).openapi('Issue');

export const SprintSchema = DocumentSchema.extend({
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
}).openapi('Sprint');

/** Shared list query. `updated_before` exists because the agent's detectors
 * filter on staleness (api/src/fleetgraph/detectors.ts) — Epic 7 cannot go
 * through the public API unless the public API can express those reads. */
export const ListQuerySchema = z.object({
  cursor: z.string().optional().openapi({ description: 'Opaque cursor from a previous response.' }),
  limit: z.coerce.number().int().positive().max(100).optional(),
  updated_before: z.string().datetime().optional(),
});

export const DocumentListQuerySchema = ListQuerySchema.extend({
  type: z.enum(PUBLIC_DOCUMENT_TYPES).optional(),
  state: z.string().optional(),
  parent_id: z.string().uuid().optional(),
});

export const IssueListQuerySchema = ListQuerySchema.extend({
  state: z.string().optional(),
  assignee_id: z.string().uuid().optional(),
});

export const IdParamSchema = z.object({ id: z.string().uuid() });

export const CreateDocumentSchema = z
  .object({
    title: z.string().min(1).max(500),
    document_type: z.enum(PUBLIC_DOCUMENT_TYPES).optional().default('wiki'),
    parent_id: z.string().uuid().optional(),
    content_text: z.string().max(100_000).optional().openapi({
      description: 'Plain-text body. Stored as a TipTap paragraph document.',
    }),
  })
  .openapi('CreateDocumentRequest');

export type CreateDocumentInput = z.infer<typeof CreateDocumentSchema>;
