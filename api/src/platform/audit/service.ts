/**
 * Reading the public audit trail — the query behind the developer portal's
 * "Audit log" screen.
 *
 * Scoped to a workspace, always. `public_audit_log` is cross-tenant by
 * construction (every app's traffic lands in one table), so workspace_id is a
 * required argument rather than an optional filter — there is no call shape
 * that reads the whole table.
 *
 * Pagination reuses the v1 keyset helpers rather than LIMIT/OFFSET: this table
 * is append-heavy and sorted newest-first, which is exactly the case where an
 * offset cursor silently repeats rows as new ones arrive under the reader.
 */
import { pool } from '../../db/client.js';
import {
  buildPage,
  clampPageSize,
  decodeCursor,
  keysetClause,
  type Page,
} from '../api/v1/pagination.js';

export interface AuditLogEntry {
  id: string;
  request_id: string;
  occurred_at: string;
  app_id: string | null;
  client_id: string | null;
  user_id: string | null;
  workspace_id: string | null;
  method: string;
  route: string;
  scope_used: string | null;
  status: number;
  latency_ms: number;
}

export interface QueryAuditLogParams {
  workspaceId: string;
  /** Narrow to a single OAuth client — the portal's per-app view. */
  clientId?: string | null;
  cursor?: string | null;
  limit?: number;
}

export async function queryAuditLog(params: QueryAuditLogParams): Promise<Page<AuditLogEntry>> {
  const pageSize = clampPageSize(params.limit);
  const where: string[] = ['workspace_id = $1'];
  const values: unknown[] = [params.workspaceId];

  if (params.clientId) {
    values.push(params.clientId);
    where.push(`client_id = $${values.length}`);
  }

  const cursor = decodeCursor(params.cursor);
  if (cursor) {
    const clause = keysetClause(cursor, {
      tsCol: 'occurred_at',
      idCol: 'id',
      paramOffset: values.length + 1,
    });
    where.push(clause.sql);
    values.push(...clause.params);
  }

  // pageSize + 1 is the lookahead buildPage uses to decide next_cursor without
  // a second COUNT query.
  values.push(pageSize + 1);

  const result = await pool.query<AuditLogEntry>(
    `SELECT id, request_id, occurred_at, app_id, client_id, user_id, workspace_id,
            method, route, scope_used, status, latency_ms
       FROM public_audit_log
      WHERE ${where.join(' AND ')}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${values.length}`,
    values
  );

  return buildPage(result.rows, pageSize, (row) => ({
    ts: new Date(row.occurred_at).toISOString(),
    id: row.id,
  }));
}
