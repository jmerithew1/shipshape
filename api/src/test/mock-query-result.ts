import type { QueryResult } from 'pg';

/**
 * Fully-typed QueryResult for pool.query mocks.
 *
 * Replaces the `{ rows: [...] } as any` casts that made test files the
 * densest type-violation sites in the audit (Cat 1): with `as any`, a mock
 * whose shape drifts from what pg actually returns still compiles and fails
 * at runtime in confusing ways; this helper keeps mock rows type-checked
 * against the real QueryResult contract.
 */
export function queryResult(
  rows: Record<string, unknown>[] = []
): QueryResult<Record<string, unknown>> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows };
}

/**
 * The narrow mock surface tests actually use on a mocked pool.query.
 *
 * pg's `query` is overloaded and its last overload (the callback form)
 * returns void, so `vi.mocked(pool.query).mockResolvedValue(...)` infers a
 * `void` parameter and rejects real QueryResults — the historical reason
 * every call site carried `as any`. This interface pins the resolved-value
 * type to QueryResult instead, with exactly one cast, here.
 */
export interface QueryMock {
  mockReset(): void;
  mockClear(): void;
  mockResolvedValue(value: QueryResult<Record<string, unknown>>): QueryMock;
  mockResolvedValueOnce(value: QueryResult<Record<string, unknown>>): QueryMock;
  mockRejectedValue(error: unknown): QueryMock;
  mockRejectedValueOnce(error: unknown): QueryMock;
  mock: { calls: unknown[][] };
}

export function asQueryMock(fn: unknown): QueryMock {
  return fn as QueryMock;
}
