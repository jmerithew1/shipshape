/**
 * Public documents / issues / sprints resources (MVP gate A4).
 *
 * These handlers are deliberately THIN and own their SQL. They do not import
 * internal route handlers — that is the public/internal boundary the ESLint
 * rule enforces, and it is what keeps the published contract independent of
 * internal refactors. They read the same tables the internal API reads, so
 * there is one source of truth for data and two independent contracts over it.
 *
 * Every query is workspace-scoped from the token context; no handler trusts a
 * workspace id from the client.
 */
import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { pool } from '../../../../db/client.js';
import { ApiError } from '../errors.js';
import { buildPage, clampPageSize, decodeCursor, keysetClause } from '../pagination.js';
import type { CreateDocumentInput } from './schemas.js';

/**
 * Express 4 does not catch rejected promises from async handlers — an
 * `await` that throws becomes an unhandled rejection and the request hangs
 * until it times out. Every async handler below is wrapped so a thrown
 * ApiError reaches the v1 error middleware and ships the public envelope.
 * (Express 5 makes this native; this is the 4.x contract.)
 */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

interface DocumentRow {
  id: string;
  title: string;
  document_type: string;
  properties: Record<string, unknown> | null;
  ticket_number: number | null;
  parent_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const asIso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

function toDocument(row: DocumentRow) {
  const props = row.properties ?? {};
  return {
    id: row.id,
    title: row.title,
    document_type: row.document_type,
    state: typeof props.state === 'string' ? props.state : null,
    ticket_number: row.ticket_number,
    parent_id: row.parent_id,
    created_at: asIso(row.created_at),
    updated_at: asIso(row.updated_at),
  };
}

function toIssue(row: DocumentRow) {
  const props = row.properties ?? {};
  return {
    ...toDocument(row),
    assignee_id: typeof props.assignee_id === 'string' ? props.assignee_id : null,
    priority: typeof props.priority === 'string' ? props.priority : null,
  };
}

function toSprint(row: DocumentRow) {
  const props = row.properties ?? {};
  return {
    ...toDocument(row),
    start_date: typeof props.start_date === 'string' ? props.start_date : null,
    end_date: typeof props.end_date === 'string' ? props.end_date : null,
  };
}

/**
 * Shared list machinery: workspace-scoped, keyset-paginated.
 *
 * Ordering is (created_at DESC, id DESC) — the same pair the cursor carries,
 * and BOTH ARE IMMUTABLE. That is load-bearing, not incidental: keyset
 * pagination is only stable if the sort key cannot change under the cursor.
 * Sorting by `updated_at` looked more useful ("newest activity first") but was
 * silently lossy — editing a not-yet-returned row moves it ABOVE the cursor,
 * so a client walking every page never receives it. Found by the contract
 * audit. `updated_before` remains available as a FILTER, which is what the
 * agent's detectors need; it is just not the sort key.
 */
async function listDocuments(
  req: Request,
  opts: {
    fixedType?: string;
    allowTypeFilter?: boolean;
    extraFilters?: (push: (sql: string, value: unknown) => void) => void;
  }
): Promise<{ rows: DocumentRow[]; pageSize: number }> {
  // Read the VALIDATED query, not the raw one. `validate()` parses req.query
  // against the route's declared schema; Zod strips unknown keys rather than
  // rejecting them, so reading req.query directly let undeclared params reach
  // SQL unvalidated — GET /api/v1/sprints?parent_id=notauuid produced a
  // Postgres 22P02 and a 500 on well-formed client input. Reading the parsed
  // object means a route only ever filters on what its schema publishes.
  // Found by the security audit.
  const q = (req.validated?.query ?? {}) as Record<string, string | undefined>;
  const pageSize = clampPageSize(q.limit);

  const where: string[] = ['d.workspace_id = $1', 'd.deleted_at IS NULL', 'd.archived_at IS NULL'];
  const params: unknown[] = [req.platform!.workspaceId];
  const push = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('$?', `$${params.length}`));
  };

  if (opts.fixedType) push('d.document_type = $?', opts.fixedType);
  else if (opts.allowTypeFilter && q.type) push('d.document_type = $?', q.type);

  if (q.updated_before) push('d.updated_at < $?', q.updated_before);
  if (q.parent_id) push('d.parent_id = $?', q.parent_id);
  if (q.state) push("d.properties->>'state' = $?", q.state);
  if (q.assignee_id) push("d.properties->>'assignee_id' = $?", q.assignee_id);
  opts.extraFilters?.(push);

  if (q.cursor) {
    const cursor = decodeCursor(q.cursor);
    if (!cursor) throw ApiError.validation('Invalid cursor', { cursor: 'not a cursor issued by this API' });
    const clause = keysetClause(cursor, { tsCol: 'd.created_at', idCol: 'd.id', paramOffset: params.length + 1 });
    where.push(clause.sql);
    params.push(...clause.params);
  }

  // pageSize + 1 is the lookahead that tells buildPage whether another page exists.
  params.push(pageSize + 1);
  // created_at/updated_at are emitted at MICROSECOND precision, not the
  // millisecond a JS Date (what the pg driver hands back for timestamptz) would
  // give. The cursor carries this value, and the keyset compares it back
  // against the microsecond-precision column — so two rows created in the same
  // millisecond are ordered and paged deterministically. With millisecond
  // truncation, a row whose created_at fell between the truncated cursor and
  // the real last-row value was silently SKIPPED. Still valid ISO 8601.
  const result = await pool.query<DocumentRow>(
    `SELECT d.id, d.title, d.document_type, d.properties, d.ticket_number,
            d.parent_id,
            to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            to_char(d.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
       FROM documents d
      WHERE ${where.join(' AND ')}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $${params.length}`,
    params
  );
  return { rows: result.rows, pageSize };
}

const cursorOf = (d: { created_at: string; id: string }) => ({ ts: d.created_at, id: d.id });

export const handleListDocuments: RequestHandler = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { rows, pageSize } = await listDocuments(req, { allowTypeFilter: true });
  res.json(buildPage(rows.map(toDocument), pageSize, cursorOf));
});

export const handleListIssues: RequestHandler = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { rows, pageSize } = await listDocuments(req, { fixedType: 'issue' });
  res.json(buildPage(rows.map(toIssue), pageSize, cursorOf));
});

export const handleListSprints: RequestHandler = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { rows, pageSize } = await listDocuments(req, { fixedType: 'sprint' });
  res.json(buildPage(rows.map(toSprint), pageSize, cursorOf));
});

async function fetchOne(req: Request, fixedType?: string): Promise<DocumentRow> {
  const params: unknown[] = [req.params.id, req.platform!.workspaceId];
  const typeClause = fixedType ? ' AND d.document_type = $3' : '';
  if (fixedType) params.push(fixedType);

  const result = await pool.query<DocumentRow>(
    `SELECT d.id, d.title, d.document_type, d.properties, d.ticket_number,
            d.parent_id, d.created_at, d.updated_at
       FROM documents d
      WHERE d.id = $1 AND d.workspace_id = $2 AND d.deleted_at IS NULL${typeClause}`,
    params
  );
  const row = result.rows[0];
  // Same 404 whether the row is missing or belongs to another workspace —
  // an existence oracle across tenants is an information leak.
  if (!row) throw ApiError.notFound('Document not found');
  return row;
}

export const handleGetDocument: RequestHandler = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  res.json(toDocument(await fetchOne(req)));
});

export const handleGetIssue: RequestHandler = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  res.json(toIssue(await fetchOne(req, 'issue')));
});

export const handleGetSprint: RequestHandler = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  res.json(toSprint(await fetchOne(req, 'sprint')));
});

export const handleCreateDocument: RequestHandler = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const body = req.body as CreateDocumentInput;
  const content = body.content_text
    ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: body.content_text }] }] }
    : { type: 'doc', content: [{ type: 'paragraph' }] };

  if (body.parent_id) {
    const parent = await pool.query('SELECT id FROM documents WHERE id = $1 AND workspace_id = $2', [
      body.parent_id,
      req.platform!.workspaceId,
    ]);
    if (!parent.rows[0]) throw ApiError.validation('parent_id does not exist in this workspace', { parent_id: body.parent_id });
  }

  const result = await pool.query<DocumentRow>(
    `INSERT INTO documents (workspace_id, document_type, title, content, parent_id, created_by)
     VALUES ($1, $2::document_type, $3, $4, $5, $6)
     RETURNING id, title, document_type, properties, ticket_number, parent_id, created_at, updated_at`,
    [
      req.platform!.workspaceId,
      body.document_type ?? 'wiki',
      body.title,
      JSON.stringify(content),
      body.parent_id ?? null,
      req.platform!.userId,
    ]
  );

  const created = result.rows[0]!;

  // Publish document.created so webhook subscribers fire for documents created
  // through the PUBLIC API — not just the internal UI path. This event type was
  // in the registry but nothing ever emitted it, so a subscription to
  // document.created never delivered (the TTFE drill, and any real integration,
  // waited forever). Best-effort and out-of-band, exactly like the internal
  // chokepoints: a webhook failure must never fail the create itself.
  try {
    const { buildEvent, publishEventSafely } = await import('../../../webhooks/index.js');
    publishEventSafely(
      buildEvent('document.created', {
        id: randomUUID(),
        workspaceId: req.platform!.workspaceId,
        data: {
          document_id: created.id,
          document_type: created.document_type,
          title: created.title,
          parent_id: created.parent_id ?? null,
        },
      })
    );
  } catch {
    /* webhook publication is best-effort by design */
  }

  res.status(201).json(toDocument(created));
});

/** GET /me — the SDK's first call and the drill's first checkpoint. */
export const handleGetMe: RequestHandler = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const ctx = req.platform!;
  const result = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [ctx.userId]);
  const user = result.rows[0];
  if (!user) throw ApiError.notFound('User not found');

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    workspace_id: ctx.workspaceId,
    client_id: ctx.clientId,
    scopes: ctx.grantedScopes,
  });
});
