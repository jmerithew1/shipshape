import { describe, expect, it } from 'vitest';
import { ShipError, kindForStatus, type ShipErrorKind } from './errors.js';

function envelope(code: string, message = 'nope', details?: Record<string, unknown>) {
  return { code, message, request_id: 'req_01HZY7', ...(details ? { details } : {}) };
}

describe('kindForStatus', () => {
  const cases: Array<[number, ShipErrorKind]> = [
    [400, 'validation'],
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not_found'],
    [422, 'validation'],
    [429, 'rate_limit'],
    [500, 'server'],
    [502, 'server'],
    [503, 'server'],
  ];

  it.each(cases)('maps %i to kind %s', (status, kind) => {
    expect(kindForStatus(status)).toBe(kind);
  });

  it('routes unlisted 4xx to validation and unlisted 5xx to server', () => {
    expect(kindForStatus(409)).toBe('validation');
    expect(kindForStatus(599)).toBe('server');
  });
});

describe('ShipError.fromResponse', () => {
  it('maps every documented status onto the right kind', () => {
    expect(ShipError.fromResponse(401, envelope('unauthorized')).kind).toBe('auth');
    expect(ShipError.fromResponse(401, envelope('token_expired')).kind).toBe('auth');
    expect(ShipError.fromResponse(403, envelope('forbidden')).kind).toBe('auth');
    expect(ShipError.fromResponse(404, envelope('not_found')).kind).toBe('not_found');
    expect(ShipError.fromResponse(400, envelope('validation_failed')).kind).toBe('validation');
    expect(ShipError.fromResponse(422, envelope('validation_failed')).kind).toBe('validation');
    expect(ShipError.fromResponse(429, envelope('rate_limited')).kind).toBe('rate_limit');
    expect(ShipError.fromResponse(500, envelope('server_error')).kind).toBe('server');
  });

  it('keeps the server error code verbatim so token_expired stays distinguishable', () => {
    const expired = ShipError.fromResponse(401, envelope('token_expired'));
    const plain = ShipError.fromResponse(401, envelope('unauthorized'));
    expect(expired.kind).toBe(plain.kind);
    expect(expired.code).toBe('token_expired');
    expect(plain.code).toBe('unauthorized');
  });

  it('carries request_id through as requestId', () => {
    const error = ShipError.fromResponse(404, envelope('not_found', 'No such document'));
    expect(error.requestId).toBe('req_01HZY7');
    expect(error.message).toBe('No such document');
    expect(error.status).toBe(404);
  });

  it('exposes details, including the 403 missing_scope hint', () => {
    const error = ShipError.fromResponse(
      403,
      envelope('forbidden', "Insufficient scope: this request requires 'documents:write'", {
        missing_scope: 'documents:write',
      })
    );
    expect(error.details).toEqual({ missing_scope: 'documents:write' });
  });

  it('reads retryAfterSeconds from the body and prefers the Retry-After header', () => {
    const fromBody = ShipError.fromResponse(
      429,
      envelope('rate_limited', 'Rate limit exceeded', { retry_after_seconds: 30 })
    );
    expect(fromBody.retryAfterSeconds).toBe(30);

    const fromHeader = ShipError.fromResponse(
      429,
      envelope('rate_limited', 'Rate limit exceeded', { retry_after_seconds: 30 }),
      7
    );
    expect(fromHeader.retryAfterSeconds).toBe(7);
  });

  it('survives a non-JSON / absent body', () => {
    for (const body of [undefined, null, 'a gateway HTML page', 42, []]) {
      const error = ShipError.fromResponse(502, body);
      expect(error.kind).toBe('server');
      expect(error.code).toBe('server_error');
      expect(error.requestId).toBe('');
      expect(error.message).toContain('502');
    }
  });

  it('is a real Error, instanceof-checkable, and narrows via ShipError.is', () => {
    const error = ShipError.fromResponse(404, envelope('not_found'));
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ShipError);
    expect(error.name).toBe('ShipError');
    expect(ShipError.is(error)).toBe(true);
    expect(ShipError.is(new Error('other'))).toBe(false);
  });
});

describe('the kind union is exhaustively switchable', () => {
  // The point of this test is the *compile*: `describeKind` has no default
  // branch and an explicit `never` check, so adding a member to ShipErrorKind
  // without handling it here fails `tsc`, not just this assertion.
  function describeKind(error: ShipError): string {
    switch (error.kind) {
      case 'auth':
        return 'reauthenticate';
      case 'rate_limit':
        return `back off ${error.retryAfterSeconds ?? 0}s`;
      case 'not_found':
        return 'gone';
      case 'validation':
        return 'fix the request';
      case 'server':
        return 'retry later';
      default: {
        const unreachable: never = error.kind;
        return unreachable;
      }
    }
  }

  it('produces a branch for every status the API can return', () => {
    expect(describeKind(ShipError.fromResponse(401, envelope('unauthorized')))).toBe(
      'reauthenticate'
    );
    expect(
      describeKind(
        ShipError.fromResponse(429, envelope('rate_limited', 'slow down', { retry_after_seconds: 12 }))
      )
    ).toBe('back off 12s');
    expect(describeKind(ShipError.fromResponse(404, envelope('not_found')))).toBe('gone');
    expect(describeKind(ShipError.fromResponse(422, envelope('validation_failed')))).toBe(
      'fix the request'
    );
    expect(describeKind(ShipError.fromResponse(500, envelope('server_error')))).toBe('retry later');
  });
});

describe('ShipError.network', () => {
  it('produces a server-kind error with status 0 when there was no response', () => {
    const error = ShipError.network(new TypeError('fetch failed'));
    expect(error.kind).toBe('server');
    expect(error.code).toBe('network_error');
    expect(error.status).toBe(0);
    expect(error.message).toContain('fetch failed');
  });
});
