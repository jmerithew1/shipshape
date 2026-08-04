/**
 * Circuit breaker for outbound LLM calls (Engineering Requirements:
 * retries/timeouts/breakers with graceful degradation).
 *
 * Retries + timeouts live on the ChatAnthropic client itself (maxRetries,
 * timeout) so LangSmith still sees every attempt as an LLM span. The breaker
 * wraps the whole call: after `threshold` consecutive failures it opens and
 * fails fast; a half-open probe is allowed after `cooldownMs`. Degraded-mode
 * behavior (rule-based findings, honest chat unavailability) is decided by
 * the caller — the breaker only reports state.
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 60_000,
  ) {}

  get state(): 'closed' | 'open' | 'half_open' {
    if (this.openedAt === null) return 'closed';
    return Date.now() - this.openedAt >= this.cooldownMs ? 'half_open' : 'open';
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      throw new BreakerOpenError();
    }
    try {
      const result = await fn();
      this.consecutiveFailures = 0;
      this.openedAt = null;
      return result;
    } catch (err) {
      if (!(err instanceof BreakerOpenError)) {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= this.threshold || this.state === 'half_open') {
          this.openedAt = Date.now();
        }
      }
      throw err;
    }
  }
}

export class BreakerOpenError extends Error {
  constructor() {
    super('LLM circuit breaker is open — running degraded (rule-based only)');
    this.name = 'BreakerOpenError';
  }
}
