/**
 * Stable CI fakes for FleetGraph E2E tests — the injectable-models seam
 * (models.ts / plan amendment 9) filled with deterministic doubles.
 *
 * Design rules:
 * - Keyed by INTENT, never by request hash: the triage fake parses the
 *   candidates the graph actually sent and answers per-candidate; the chat
 *   fake echoes the document context the graph actually loaded. If the graph
 *   stops passing real context, the assertions fail — the fakes prove the
 *   wiring, not just the happy path.
 * - Zero network, zero LLM: everything extends FakeListChatModel from
 *   @langchain/core/utils/testing, which type-checks as BaseChatModel and
 *   satisfies the FleetModels contract.
 */
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { FleetModels } from './models.js';
import { CircuitBreaker } from './resilience.js';

/** Marker prefix proving the (fake) LLM ran — asserted on finding titles. */
export const FAKE_TRIAGE_PREFIX = 'FAKE-TRIAGE:';
/** Marker prefix proving the (fake) chat model answered from real context. */
export const FAKE_CHAT_PREFIX = 'FAKE-CHAT (grounded):';
/** Error message thrown by the failing fakes (simulated provider outage). */
export const FAKE_OUTAGE_MESSAGE = 'FAKE: simulated LLM provider outage';

function contentToString(message: BaseMessage | undefined): string {
  if (!message) return '';
  return typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content);
}

function toChatResult(text: string): ChatResult {
  return { generations: [{ message: new AIMessage(text), text }], llmOutput: {} };
}

/**
 * Triage fake — parses the graph's real triage payload
 * (HumanMessage content = JSON {"findings": [candidates]}, per graph.ts) and
 * returns the JSON array contract [{dedupKey, title, body}], one entry per
 * candidate, deterministically derived from each candidate's own fields.
 */
export class FakeTriageModel extends FakeListChatModel {
  constructor() {
    super({ responses: ['[]'] });
  }

  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const human = contentToString(messages[messages.length - 1]);
    let candidates: Array<{ dedupKey?: string; documentTitle?: string; detector?: string }> = [];
    try {
      const payload = JSON.parse(human) as { findings?: typeof candidates };
      candidates = payload.findings ?? [];
    } catch {
      candidates = [];
    }
    const cards = candidates.map((c) => ({
      dedupKey: c.dedupKey ?? 'unknown',
      title: `${FAKE_TRIAGE_PREFIX} "${c.documentTitle ?? 'unknown'}" flagged by ${c.detector ?? 'detector'}`,
      body: 'Deterministic fake triage body: evidence receipt + next step.',
    }));
    return toChatResult(JSON.stringify(cards));
  }
}

/**
 * Chat fake — parses the graph's real chat payload
 * (HumanMessage content = JSON {viewing, recentIssues, question}, per
 * graph.ts respond node) and answers with the loaded document's title and
 * the user's question, proving the response is grounded in DB context that
 * flowed through the real route -> graph -> Postgres path.
 */
export class FakeGroundedChatModel extends FakeListChatModel {
  constructor() {
    super({ responses: ['unused'] });
  }

  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const human = contentToString(messages[messages.length - 1]);
    let viewingTitle = 'unknown document';
    let viewingState = 'unknown';
    let question = '';
    try {
      const payload = JSON.parse(human) as {
        viewing?: { title?: string; properties?: { state?: string } } | null;
        question?: string;
      };
      viewingTitle = payload.viewing?.title ?? viewingTitle;
      viewingState = payload.viewing?.properties?.state ?? viewingState;
      question = payload.question ?? '';
    } catch {
      /* keep defaults — assertions will catch it */
    }
    return toChatResult(
      `${FAKE_CHAT_PREFIX} You are viewing "${viewingTitle}" (state: ${viewingState}). ` +
        `Your question was: "${question}". This answer is grounded in the document ` +
        `context the graph loaded from the database.`,
    );
  }
}

/** Always-failing model — drives the degraded / breaker-open path. */
export class FailingChatModel extends FakeListChatModel {
  constructor() {
    super({ responses: ['unused'] });
  }

  override async _generate(): Promise<ChatResult> {
    throw new Error(FAKE_OUTAGE_MESSAGE);
  }
}

/** Plain scripted fake (spec'd export): one grounded-sounding canned reply. */
export const fakeChatModel = (): FakeListChatModel =>
  new FakeListChatModel({
    responses: [
      `${FAKE_CHAT_PREFIX} canned reply grounded in the provided document context.`,
    ],
  });

/**
 * Build a FleetModels bundle for tests.
 *
 * - default: intent-keyed triage + grounded chat, healthy breaker.
 * - failing: both models throw; breaker threshold=1 so the FIRST failure
 *   opens the circuit — subsequent calls fail fast with BreakerOpenError,
 *   letting tests assert genuine breaker-open degraded behavior.
 */
export function makeFakeModels(opts: { failing?: boolean } = {}): FleetModels {
  if (opts.failing) {
    return {
      triage: new FailingChatModel(),
      chat: new FailingChatModel(),
      breaker: new CircuitBreaker(1, 60_000),
    };
  }
  return {
    triage: new FakeTriageModel(),
    chat: new FakeGroundedChatModel(),
    breaker: new CircuitBreaker(),
  };
}
