/**
 * Event registry tests.
 *
 * Two things are being defended here. First, the catalog is the contract:
 * exactly eight types, spelled exactly this way, because subscribers filter on
 * those strings and a rename is a breaking change for every integration.
 * Second — and this is the one that matters for the security story — payloads
 * are THIN. The last test in this file is a structural assertion that no
 * payload schema has a field capable of carrying document content.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
  ShipEventSchema,
  assertKnownEventType,
  buildEvent,
  idempotencyKeyFor,
  isKnownEventType,
} from './events.js';

describe('the catalog', () => {
  it('publishes exactly the eight documented event types', () => {
    expect([...EVENT_TYPES]).toEqual([
      'document.created',
      'document.updated',
      'document.deleted',
      'issue.created',
      'issue.assigned',
      'issue.status_changed',
      'sprint.started',
      'sprint.completed',
    ]);
  });

  it('has a payload schema for every type and no orphan schemas', () => {
    expect(Object.keys(EVENT_PAYLOAD_SCHEMAS).sort()).toEqual([...EVENT_TYPES].sort());
  });
});

describe('assertKnownEventType', () => {
  it('accepts every registered type', () => {
    for (const type of EVENT_TYPES) expect(() => assertKnownEventType(type)).not.toThrow();
  });

  it('rejects typos, near misses, and non-strings — naming the registry file', () => {
    for (const bad of ['issue.create', 'Issue.Created', '', null, undefined, 42, {}]) {
      expect(() => assertKnownEventType(bad)).toThrow(/Unknown webhook event type/);
      expect(isKnownEventType(bad)).toBe(false);
    }
    expect(() => assertKnownEventType('issue.create')).toThrow(/events\.ts/);
  });
});

describe('buildEvent', () => {
  it('produces a validated envelope that round-trips through the union schema', () => {
    const event = buildEvent('issue.status_changed', {
      id: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      occurredAt: new Date(Date.UTC(2026, 7, 12, 12, 0, 0)),
      data: {
        issue_id: crypto.randomUUID(),
        title: 'Ship the webhooks',
        ticket_number: 12,
        from_state: 'in_progress',
        to_state: 'in_review',
      },
    });

    expect(event.occurred_at).toBe('2026-08-12T12:00:00.000Z');
    expect(ShipEventSchema.safeParse(event).success).toBe(true);
  });

  it('narrows `data` on the discriminant (the union is real, not cosmetic)', () => {
    const event = buildEvent('sprint.completed', {
      id: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      data: { sprint_id: crypto.randomUUID(), title: 'Week 6', end_date: null, completed_issue_count: 9 },
    });
    if (event.type === 'sprint.completed') {
      expect(event.data.completed_issue_count).toBe(9);
    } else {
      throw new Error('discriminant did not narrow');
    }
  });

  it('rejects a payload that does not match its declared schema', () => {
    expect(() =>
      buildEvent('issue.created', {
        id: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        // @ts-expect-error deliberately wrong shape — the point is the runtime guard
        data: { nope: true },
      })
    ).toThrow();
  });

  it('derives one idempotency key per EVENT, stable across calls', () => {
    const id = crypto.randomUUID();
    expect(idempotencyKeyFor({ id })).toBe(`evt_${id}`);
    expect(idempotencyKeyFor({ id })).toBe(idempotencyKeyFor({ id }));
  });
});

describe('payloads are thin (PRESEARCH-W6.md §1.4)', () => {
  it('declares no field that could carry document content', () => {
    // A structural guard, not a spot check: if somebody adds `content`,
    // `body`, `description`, `text`, or `comment` to a payload schema to save
    // a subscriber one GET, this fails and the tradeoff gets discussed.
    const FORBIDDEN = ['content', 'body', 'text', 'description', 'comment', 'html', 'markdown'];
    for (const type of EVENT_TYPES) {
      const shape = Object.keys(EVENT_PAYLOAD_SCHEMAS[type].shape as Record<string, unknown>);
      for (const field of shape) {
        for (const forbidden of FORBIDDEN) {
          expect(
            field.toLowerCase().includes(forbidden),
            `payload for '${type}' declares '${field}', which looks like content`
          ).toBe(false);
        }
      }
    }
  });

  it('keeps document.updated to field NAMES, never old/new values', () => {
    const parsed = EVENT_PAYLOAD_SCHEMAS['document.updated'].parse({
      document_id: crypto.randomUUID(),
      document_type: 'issue',
      title: 'Title',
      parent_id: null,
      changed_fields: ['state', 'assignee_id'],
    });
    expect(parsed.changed_fields).toEqual(['state', 'assignee_id']);
    // Extra keys are stripped by Zod rather than smuggled through.
    const sneaky = EVENT_PAYLOAD_SCHEMAS['document.updated'].parse({
      document_id: crypto.randomUUID(),
      document_type: 'issue',
      title: 'Title',
      parent_id: null,
      changed_fields: [],
      content: 'the entire document body',
    });
    expect(sneaky).not.toHaveProperty('content');
  });
});
