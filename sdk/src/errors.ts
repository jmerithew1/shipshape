/**
 * The SDK's single failure type.
 *
 * Design contract: every failure a consumer can act on differently gets its
 * own `kind`, and `kind` is a closed union — so `switch (err.kind)` is
 * exhaustive and TypeScript will fail the build if a new kind is added and a
 * consumer forgets to handle it. Anything narrower than "act on it
 * differently" stays in `code`, which is the API's own error code string
 * (`unauthorized`, `token_expired`, `validation_failed`, ...) and is free to
 * grow without breaking a switch.
 *
 * The wire envelope this parses is the one every /api/v1 route emits:
 *   { code, message, details?, request_id }
 */

export type ShipErrorKind = 'auth' | 'rate_limit' | 'not_found' | 'validation' | 'server';

export interface ShipErrorInit {
  kind: ShipErrorKind;
  code: string;
  message: string;
  /** HTTP status, or 0 when the failure never reached a response. */
  status?: number;
  requestId?: string;
  details?: Record<string, unknown>;
  retryAfterSeconds?: number;
}

/** The error body shape emitted by every /api/v1 route. */
export interface ShipErrorBody {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  request_id?: unknown;
}

/**
 * Status → kind. 401 and 403 deliberately collapse to a single `auth` kind:
 * both mean "this token cannot do this", and the distinction a caller
 * actually needs (refresh vs. request more scope) lives in `code`, which
 * carries `token_expired` / `forbidden` verbatim from the server.
 */
export function kindForStatus(status: number): ShipErrorKind {
  switch (status) {
    case 400:
    case 422:
      return 'validation';
    case 401:
    case 403:
      return 'auth';
    case 404:
      return 'not_found';
    case 429:
      return 'rate_limit';
    default:
      // Unlisted 4xx (409 conflict, 412, ...) are caller-fixable, so they
      // land in `validation`. Everything else is ours to fix.
      return status >= 400 && status < 500 ? 'validation' : 'server';
  }
}

const DEFAULT_CODE_FOR_KIND: Record<ShipErrorKind, string> = {
  auth: 'unauthorized',
  rate_limit: 'rate_limited',
  not_found: 'not_found',
  validation: 'validation_failed',
  server: 'server_error',
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class ShipError extends Error {
  readonly kind: ShipErrorKind;
  readonly code: string;
  readonly requestId: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  /** Only ever set on `kind: 'rate_limit'` (and on 503s that send Retry-After). */
  readonly retryAfterSeconds?: number;

  constructor(init: ShipErrorInit) {
    super(init.message);
    this.name = 'ShipError';
    this.kind = init.kind;
    this.code = init.code;
    this.status = init.status ?? 0;
    this.requestId = init.requestId ?? '';
    if (init.details !== undefined) this.details = init.details;
    if (init.retryAfterSeconds !== undefined) this.retryAfterSeconds = init.retryAfterSeconds;
  }

  static is(value: unknown): value is ShipError {
    return value instanceof ShipError;
  }

  /**
   * Build a ShipError from an HTTP status and a (possibly non-JSON, possibly
   * absent) response body. Never throws: a server that returns an HTML error
   * page still yields a usable typed error.
   *
   * `retryAfterSeconds` may be supplied by the caller from the `Retry-After`
   * header; the body's `details.retry_after_seconds` is the fallback.
   */
  static fromResponse(status: number, body: unknown, retryAfterSeconds?: number): ShipError {
    const kind = kindForStatus(status);
    const envelope = asRecord(body) as ShipErrorBody | undefined;
    const details = asRecord(envelope?.details);

    const code =
      typeof envelope?.code === 'string' && envelope.code.length > 0
        ? envelope.code
        : DEFAULT_CODE_FOR_KIND[kind];

    const message =
      typeof envelope?.message === 'string' && envelope.message.length > 0
        ? envelope.message
        : `Ship API request failed with status ${status}`;

    const requestId = typeof envelope?.request_id === 'string' ? envelope.request_id : '';

    const bodyRetryAfter = details?.['retry_after_seconds'];
    const retry =
      retryAfterSeconds ?? (typeof bodyRetryAfter === 'number' ? bodyRetryAfter : undefined);

    const init: ShipErrorInit = { kind, code, message, status, requestId };
    if (details !== undefined) init.details = details;
    if (retry !== undefined) init.retryAfterSeconds = retry;
    return new ShipError(init);
  }

  /** A failure that never produced a response (DNS, TLS, offline, abort). */
  static network(cause: unknown): ShipError {
    const message = cause instanceof Error ? cause.message : String(cause);
    return new ShipError({
      kind: 'server',
      code: 'network_error',
      message: `Could not reach the Ship API: ${message}`,
      status: 0,
    });
  }
}
