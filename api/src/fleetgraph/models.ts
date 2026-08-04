/**
 * Injectable model clients — the CI-fakes seam (plan amendment 9).
 *
 * The graph never constructs its own LLM client. Real runs get ChatAnthropic
 * (so LangSmith traces carry token/prompt spans — never the raw SDK); CI gets
 * scripted fakes keyed by intent, not request hash. Model routing per
 * DECISIONS.md: haiku for triage (detector-pre-structured input), sonnet for
 * chat (user-facing quality).
 */
import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { CircuitBreaker } from './resilience.js';

export interface FleetModels {
  triage: BaseChatModel;
  chat: BaseChatModel;
  breaker: CircuitBreaker;
}

export const TRIAGE_MODEL = 'claude-haiku-4-5';
export const CHAT_MODEL = 'claude-sonnet-5';

export function llmConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function buildRealModels(): FleetModels {
  const common = {
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 3, // exponential backoff w/ jitter is built into the client
    timeout: 30_000,
  };
  return {
    triage: new ChatAnthropic({ ...common, model: TRIAGE_MODEL, maxTokens: 1024 }),
    chat: new ChatAnthropic({ ...common, model: CHAT_MODEL, maxTokens: 1500 }),
    breaker: new CircuitBreaker(),
  };
}
