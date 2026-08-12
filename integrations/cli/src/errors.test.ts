/**
 * The exit-code contract.
 *
 * A CLI's exit code is API. `ship docs ls || retry` is a script somebody will
 * write, and it is only writable if 2 always means "log in again" and 5 always
 * means "back off". These tests pin that mapping, and pin the promise that a
 * user never sees a stack trace for a failure the server explained.
 */
import { describe, expect, it } from 'vitest';
import { ShipError, type ShipErrorKind } from '@ship/sdk';
import { describeError, EXIT, exitCodeFor, exitCodeForKind, reportError } from './errors.js';

function shipError(kind: ShipErrorKind, overrides: Partial<ShipError> = {}): ShipError {
  return new ShipError({
    kind,
    code: (overrides.code as string) ?? 'some_code',
    message: (overrides.message as string) ?? 'something went wrong',
    status: (overrides.status as number) ?? 500,
    requestId: (overrides.requestId as string) ?? 'req_123',
  });
}

describe('exit codes', () => {
  it.each<[ShipErrorKind, number]>([
    ['auth', EXIT.auth],
    ['validation', EXIT.validation],
    ['not_found', EXIT.notFound],
    ['rate_limit', EXIT.rateLimit],
    ['server', EXIT.server],
  ])('maps kind %s to exit %i', (kind, expected) => {
    expect(exitCodeForKind(kind)).toBe(expected);
    expect(exitCodeFor(shipError(kind))).toBe(expected);
  });

  it('gives every kind a distinct code, so a script can branch on $?', () => {
    const kinds: ShipErrorKind[] = ['auth', 'validation', 'not_found', 'rate_limit', 'server'];
    const codes = kinds.map(exitCodeForKind);
    expect(new Set(codes).size).toBe(kinds.length);
    expect(codes).not.toContain(EXIT.ok);
  });

  it('falls back to 1 for anything that is not a ShipError', () => {
    expect(exitCodeFor(new Error('boom'))).toBe(EXIT.unexpected);
    expect(exitCodeFor('a string')).toBe(EXIT.unexpected);
    expect(exitCodeFor(undefined)).toBe(EXIT.unexpected);
  });
});

describe('describeError', () => {
  it('leads with the API code and message and never a stack', () => {
    const text = describeError(
      shipError('auth', { code: 'token_expired', message: 'Access token has expired', status: 401 })
    );
    expect(text).toContain('token_expired');
    expect(text).toContain('Access token has expired');
    expect(text).toContain('HTTP 401');
    expect(text).not.toContain('    at ');
  });

  it('surfaces the request id, which is the only handle support has', () => {
    expect(describeError(shipError('server', { requestId: 'req_abcdef' }))).toContain('req_abcdef');
  });

  it('tells an expired session what to do next', () => {
    expect(describeError(shipError('auth', { code: 'token_expired' }))).toContain('ship login');
  });

  it('reports the retry delay when the server gave one', () => {
    const limited = new ShipError({
      kind: 'rate_limit',
      code: 'rate_limited',
      message: 'too many requests',
      status: 429,
      retryAfterSeconds: 30,
    });
    expect(describeError(limited)).toContain('30s');
  });

  it('prints a plain Error as one line, not a stack dump', () => {
    const text = describeError(new Error('could not parse --limit'));
    expect(text).toBe('ship: could not parse --limit');
  });

  it('handles a thrown non-Error without crashing the reporter', () => {
    expect(describeError({ weird: true })).toContain('ship:');
  });
});

describe('reportError', () => {
  it('writes the description and returns the exit code the caller should use', () => {
    const lines: string[] = [];
    const code = reportError(shipError('not_found', { status: 404 }), (line) => lines.push(line));
    expect(code).toBe(EXIT.notFound);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ship:');
  });
});
