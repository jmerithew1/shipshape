/**
 * ShipError → process exit code, and ShipError → something a human can act on.
 *
 * Two things this module is responsible for, both of them CLI-grade contracts:
 *
 *  1. **A distinct exit code per failure kind.** A script wrapping the CLI can
 *     branch on `$?` — 2 means "log in again", 5 means "back off and retry" —
 *     without parsing English out of stderr. The mapping is a `switch` over the
 *     SDK's closed `ShipErrorKind` union, so adding a kind to the SDK fails
 *     THIS build until the CLI decides what it means.
 *
 *  2. **Never a stack trace.** A stack is a bug report about the CLI; the user
 *     hit an expired token. The message carries the API's own `code`, its
 *     message, the request id (so support can find it) and a next action.
 */
import { ShipError, type ShipErrorKind } from '@ship/sdk';

/**
 * Exit codes. 0/1 keep their universal meanings (success, unexpected crash);
 * 2-6 are ours and are stable API.
 */
export const EXIT = {
  ok: 0,
  unexpected: 1,
  auth: 2,
  validation: 3,
  notFound: 4,
  rateLimit: 5,
  server: 6,
} as const;

/** Exhaustive by construction — a new ShipErrorKind breaks compilation here. */
export function exitCodeForKind(kind: ShipErrorKind): number {
  switch (kind) {
    case 'auth':
      return EXIT.auth;
    case 'validation':
      return EXIT.validation;
    case 'not_found':
      return EXIT.notFound;
    case 'rate_limit':
      return EXIT.rateLimit;
    case 'server':
      return EXIT.server;
  }
}

export function exitCodeFor(error: unknown): number {
  return ShipError.is(error) ? exitCodeForKind(error.kind) : EXIT.unexpected;
}

/** The one actionable sentence per kind. Kept here so every command agrees. */
function hintForKind(kind: ShipErrorKind, error: ShipError): string {
  switch (kind) {
    case 'auth':
      return error.code === 'token_expired'
        ? 'Your session expired. Run `ship login` again.'
        : 'Not authorized. Run `ship login`, or ask for a token with the scope this call needs.';
    case 'validation':
      return 'The request was rejected. Check the arguments above against `ship <command> --help`.';
    case 'not_found':
      return 'No such resource on this server. Check the id, and check --base-url.';
    case 'rate_limit': {
      const seconds = error.retryAfterSeconds;
      return seconds === undefined
        ? 'Rate limited. Wait a moment and retry.'
        : `Rate limited. Retry in ${seconds}s.`;
    }
    case 'server':
      return error.code === 'network_error'
        ? 'Could not reach the server. Check your connection and --base-url.'
        : 'The server failed. This one is not yours to fix — quote the request id above.';
  }
}

/**
 * A readable, stack-free rendering. Shape:
 *
 *     ship: token_expired — Access token has expired (401)
 *       request id: 6f2c…
 *       Your session expired. Run `ship login` again.
 */
export function describeError(error: unknown): string {
  if (ShipError.is(error)) {
    const status = error.status > 0 ? ` (HTTP ${error.status})` : '';
    const lines = [`ship: ${error.code} — ${error.message}${status}`];
    if (error.requestId !== '') lines.push(`  request id: ${error.requestId}`);
    lines.push(`  ${hintForKind(error.kind, error)}`);
    return lines.join('\n');
  }
  if (error instanceof Error) {
    // Message only. The stack goes nowhere unless SHIP_DEBUG asks for it.
    const stack = process.env['SHIP_DEBUG'] === '1' && error.stack ? `\n${error.stack}` : '';
    return `ship: ${error.message}${stack}`;
  }
  return `ship: ${String(error)}`;
}

/** Render to the given writer and return the exit code the caller should use. */
export function reportError(error: unknown, write: (line: string) => void): number {
  write(describeError(error));
  return exitCodeFor(error);
}
