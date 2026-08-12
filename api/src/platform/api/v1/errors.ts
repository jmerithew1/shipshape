/**
 * ApiError — the single error envelope for every /api/v1 failure.
 *
 * Contract (Week 6 brief, "Consistent Error Shape"):
 *   { code, message, details?, request_id }
 *
 * The code union extends the brief's interface with 'token_expired': the MVP
 * hard gate requires expired tokens to return 401 "with a distinct error
 * code", which a shared 'unauthorized' cannot satisfy. Logged in DECISIONS.md.
 *
 * The fitness test (fitness.test.ts) asserts this shape on every v1 route's
 * failure paths; nothing on the public surface may respond with any other
 * error body.
 */

export const API_ERROR_CODES = [
  'unauthorized',
  'token_expired',
  'forbidden',
  'not_found',
  'validation_failed',
  'rate_limited',
  'server_error',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
  request_id: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toBody(requestId: string): ApiErrorBody {
    const body: ApiErrorBody = {
      code: this.code,
      message: this.message,
      request_id: requestId,
    };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }

  static unauthorized(message = 'Authentication required', details?: Record<string, unknown>) {
    return new ApiError(401, 'unauthorized', message, details);
  }

  /** Expired tokens are 401 like other auth failures, but with a distinct
   * code so clients can trigger refresh instead of re-login (MVP gate A3). */
  static tokenExpired(message = 'Access token has expired', details?: Record<string, unknown>) {
    return new ApiError(401, 'token_expired', message, details);
  }

  /** 403s must name the missing scope explicitly — no opaque "forbidden". */
  static insufficientScope(missingScope: string) {
    return new ApiError(403, 'forbidden', `Insufficient scope: this request requires '${missingScope}'`, {
      missing_scope: missingScope,
    });
  }

  static forbidden(message = 'Forbidden', details?: Record<string, unknown>) {
    return new ApiError(403, 'forbidden', message, details);
  }

  static notFound(message = 'Not found', details?: Record<string, unknown>) {
    return new ApiError(404, 'not_found', message, details);
  }

  static validation(message = 'Request validation failed', details?: Record<string, unknown>) {
    return new ApiError(400, 'validation_failed', message, details);
  }

  static rateLimited(retryAfterSeconds: number) {
    return new ApiError(429, 'rate_limited', 'Rate limit exceeded', {
      retry_after_seconds: retryAfterSeconds,
    });
  }

  static server(message = 'Internal server error') {
    return new ApiError(500, 'server_error', message);
  }
}
