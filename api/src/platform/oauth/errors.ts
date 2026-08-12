/**
 * OAuth protocol errors — RFC 6749 §5.2 / RFC 8628 §3.5 shape.
 *
 * The rest of the public surface answers with ApiError
 * (api/src/platform/api/v1/errors.ts: { code, message, details?, request_id }).
 * The OAuth *protocol* endpoints deliberately do NOT: RFC 6749 §5.2 pins the
 * body to { "error": ..., "error_description": ... } and every conforming
 * OAuth client in existence parses that and only that. Reshaping it into the
 * house envelope would make Ship's authorization server unusable by stock
 * client libraries, so /oauth/* is the one carve-out from the v1 envelope.
 *
 * Keep the carve-out narrow: only endpoints under /oauth speak this dialect.
 */
import type { Response } from 'express';

/** RFC 6749 §4.1.2.1 / §5.2 plus the RFC 8628 §3.5 device-grant additions. */
export const OAUTH_ERROR_CODES = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'unsupported_response_type',
  'invalid_scope',
  'access_denied',
  'server_error',
  // RFC 8628 §3.5 device authorization grant
  'authorization_pending',
  'slow_down',
  'expired_token',
] as const;

export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

export interface OAuthErrorBody {
  error: OAuthErrorCode;
  error_description: string;
}

/**
 * Write an RFC 6749 §5.2 error body.
 *
 * Token-endpoint responses must not be cached (RFC 6749 §5.1), and that
 * applies to the error responses too — they can carry rate-limit-shaped
 * signals (slow_down) that a cache would happily replay.
 */
export function oauthError(
  res: Response,
  status: number,
  error: OAuthErrorCode,
  errorDescription: string
): void {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  const body: OAuthErrorBody = { error, error_description: errorDescription };
  res.status(status).json(body);
}
