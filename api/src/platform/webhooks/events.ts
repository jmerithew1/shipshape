/**
 * The event registry — events as DATA (Week 6, "PlugForge", Epic 3).
 *
 * The assignment's extension test for webhooks is the same shape as the one
 * for scopes: add a new event type without editing the bus, the deliverer, or
 * any route. This file is the only place an event type is spelled out. Every
 * consumer — the bus's subscription matcher, the subscription-create
 * validator, the OpenAPI enum, the portal's event picker — asks this module,
 * so a ninth event type is one entry here and zero edits elsewhere.
 *
 * WHY PAYLOADS ARE THIN (PRESEARCH-W6.md §1.4, defended tradeoff)
 * ---------------------------------------------------------------
 * A webhook payload is content sprayed at every registered URL, forever,
 * whether or not the subscriber still needs it — and unlike an API read it is
 * not gated on the subscriber's scopes at the moment of delivery. So payloads
 * carry IDs, the event type, and the few display fields a subscriber needs to
 * decide "do I care?" — never document content, never comment text, never
 * anything that would let a webhook endpoint reconstruct the workspace.
 * A subscriber that needs the body issues one GET with its OWN scoped token,
 * which means the read is authorized at read time and shows up in
 * public_audit_log under the subscriber's client_id.
 *
 * The cost is one extra round trip per interesting event. That is the trade:
 * subscriber convenience vs. exposure surface, and exposure wins.
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// The catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every event type Ship publishes. Order is stable and public: it is what the
 * OpenAPI enum and the portal's checkbox list render from.
 */
export const EVENT_TYPES = [
  'document.created',
  'document.updated',
  'document.deleted',
  'issue.created',
  'issue.assigned',
  'issue.status_changed',
  'sprint.started',
  'sprint.completed',
] as const;

export type ShipEventType = (typeof EVENT_TYPES)[number];

/** Zod enum over the catalog — derived, never re-typed. */
export const ShipEventTypeSchema = z.enum(EVENT_TYPES);

// ─────────────────────────────────────────────────────────────────────────────
// Payload schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shared document shoulders. `title` is the one display field: a subscriber
 * routing "new spec published" to a Slack channel needs a human label, and a
 * title is already visible in every list view the same token can read.
 */
const DocumentRefSchema = z.object({
  document_id: z.string().uuid(),
  document_type: z.string(),
  title: z.string(),
  parent_id: z.string().uuid().nullable(),
});

const IssueRefSchema = z.object({
  issue_id: z.string().uuid(),
  title: z.string(),
  ticket_number: z.number().int().nullable(),
});

const SprintRefSchema = z.object({
  sprint_id: z.string().uuid(),
  title: z.string(),
});

/**
 * The per-type payload schemas, keyed by event type. This object IS the
 * registry: `EVENT_TYPES` names the types, this maps each to its contract.
 */
export const EVENT_PAYLOAD_SCHEMAS = {
  'document.created': DocumentRefSchema,
  'document.updated': DocumentRefSchema.extend({
    /** Which tracked fields changed. Names only — never old/new values, which
     *  would smuggle document content into the payload through the back door. */
    changed_fields: z.array(z.string()),
  }),
  // A deleted document cannot be fetched afterwards, so this payload is the
  // last thing a subscriber will ever learn about it. It is still ids-only:
  // a tombstone is a signal to purge, not a final content export.
  'document.deleted': z.object({
    document_id: z.string().uuid(),
    document_type: z.string(),
  }),
  'issue.created': IssueRefSchema.extend({
    state: z.string().nullable(),
    priority: z.string().nullable(),
    assignee_id: z.string().uuid().nullable(),
  }),
  'issue.assigned': IssueRefSchema.extend({
    assignee_id: z.string().uuid().nullable(),
    previous_assignee_id: z.string().uuid().nullable(),
  }),
  'issue.status_changed': IssueRefSchema.extend({
    from_state: z.string().nullable(),
    to_state: z.string().nullable(),
  }),
  'sprint.started': SprintRefSchema.extend({
    start_date: z.string().nullable(),
    end_date: z.string().nullable(),
  }),
  'sprint.completed': SprintRefSchema.extend({
    end_date: z.string().nullable(),
    completed_issue_count: z.number().int().nullable(),
  }),
} as const satisfies Record<ShipEventType, z.ZodTypeAny>;

export type EventPayloadMap = {
  [K in ShipEventType]: z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[K]>;
};

// ─────────────────────────────────────────────────────────────────────────────
// The envelope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every event on the wire. `id` is the event identity: it mints the
 * idempotency key, so retries AND manual replays of the same event all carry
 * the same key and a subscriber can dedupe on it (delivery is at-least-once —
 * that is the documented contract, not an accident).
 */
export interface ShipEventEnvelope<K extends ShipEventType = ShipEventType> {
  id: string;
  type: K;
  workspace_id: string;
  /** ISO-8601 UTC. */
  occurred_at: string;
  data: EventPayloadMap[K];
}

/** The discriminated union: `switch (event.type)` narrows `event.data`. */
export type ShipEvent = {
  [K in ShipEventType]: ShipEventEnvelope<K>;
}[ShipEventType];

const envelopeShape = {
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  occurred_at: z.string(),
};

/**
 * Full envelope validation as a Zod discriminated union, built by mapping the
 * catalog. Adding an event type extends this automatically.
 */
const eventVariants = EVENT_TYPES.map((type) =>
  z.object({
    ...envelopeShape,
    type: z.literal(type),
    data: EVENT_PAYLOAD_SCHEMAS[type],
  })
) as unknown as [
  z.ZodDiscriminatedUnionOption<'type'>,
  ...z.ZodDiscriminatedUnionOption<'type'>[],
];

export const ShipEventSchema = z.discriminatedUnion('type', eventVariants);

// ─────────────────────────────────────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────────────────────────────────────

export function isKnownEventType(value: unknown): value is ShipEventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Throws on an unknown event type, listing the known ones.
 *
 * Called at subscription-create time (so a typo'd event type is a 400 with a
 * useful message, not a subscription that silently never fires) and at publish
 * time (so a typo in a chokepoint dies loudly in development). The error text
 * names the registry file for the same reason ScopeRegistry.assertKnown does:
 * the fix should be obvious from the message alone.
 */
export function assertKnownEventType(value: unknown): asserts value is ShipEventType {
  if (!isKnownEventType(value)) {
    throw new Error(
      `Unknown webhook event type: '${String(value)}'. Known types: ${EVENT_TYPES.join(', ')}. ` +
        `Register new event types in api/src/platform/webhooks/events.ts.`
    );
  }
}

/**
 * Build a validated envelope. Chokepoints call this rather than constructing
 * object literals, so a payload that drifts from its schema fails at the
 * publish site instead of at some subscriber's parser three hops away.
 */
export function buildEvent<K extends ShipEventType>(
  type: K,
  input: { id: string; workspaceId: string; occurredAt?: Date | string; data: EventPayloadMap[K] }
): ShipEventEnvelope<K> {
  assertKnownEventType(type);
  const occurredAt = input.occurredAt ?? new Date();
  const envelope: ShipEventEnvelope<K> = {
    id: input.id,
    type,
    workspace_id: input.workspaceId,
    occurred_at: occurredAt instanceof Date ? occurredAt.toISOString() : occurredAt,
    data: EVENT_PAYLOAD_SCHEMAS[type].parse(input.data) as EventPayloadMap[K],
  };
  return envelope;
}

/**
 * The idempotency key a delivery carries. Derived from the event id ONCE and
 * then copied verbatim through every retry and every replay — the replay path
 * in service.ts depends on this being a pure function of the event, not of the
 * delivery attempt.
 */
export function idempotencyKeyFor(event: Pick<ShipEvent, 'id'>): string {
  return `evt_${event.id}`;
}
