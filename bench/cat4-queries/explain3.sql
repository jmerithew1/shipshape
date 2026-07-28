\echo ==================== Q7 /api/projects list (SLOWEST measured query) ====================
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
      SELECT d.id, d.title, d.properties, prog_da.related_id as program_id, d.archived_at, d.created_at, d.updated_at,
             d.converted_from_id,
             (d.properties->>'owner_id')::uuid as owner_id,
             u.name as owner_name, u.email as owner_email,
             (SELECT COUNT(*) FROM documents s
              JOIN document_associations da ON da.document_id = s.id AND da.related_id = d.id AND da.relationship_type = 'project'
              WHERE s.document_type = 'sprint') as sprint_count,
             (SELECT COUNT(*) FROM documents i
              JOIN document_associations da ON da.document_id = i.id AND da.related_id = d.id AND da.relationship_type = 'project'
              WHERE i.document_type = 'issue') as issue_count,
             (
      CASE
        WHEN d.archived_at IS NOT NULL THEN 'archived'
        WHEN d.properties->>'plan_validated' IS NOT NULL THEN 'completed'
        ELSE COALESCE(
          (
            SELECT
              CASE MAX(
                CASE
                  WHEN CURRENT_DATE BETWEEN
                    (w.sprint_start_date + ((sprint.properties->>'sprint_number')::int - 1) * 7)
                    AND (w.sprint_start_date + ((sprint.properties->>'sprint_number')::int - 1) * 7 + 6)
                  THEN 3
                  WHEN CURRENT_DATE < (w.sprint_start_date + ((sprint.properties->>'sprint_number')::int - 1) * 7)
                  THEN 2
                  ELSE 1
                END
              )
              WHEN 3 THEN 'active'
              WHEN 2 THEN 'planned'
              ELSE NULL
              END
            FROM documents sprint
            JOIN workspaces w ON w.id = sprint.workspace_id
            WHERE sprint.document_type = 'sprint'
              AND sprint.workspace_id = d.workspace_id
              AND (sprint.properties->>'project_id')::uuid = d.id
              AND jsonb_array_length(COALESCE(sprint.properties->'assignee_ids', '[]'::jsonb)) > 0
          ),
          'backlog'
        )
      END
    ) as inferred_status
      FROM documents d
      LEFT JOIN users u ON u.id = (d.properties->>'owner_id')::uuid
      LEFT JOIN document_associations prog_da ON prog_da.document_id = d.id AND prog_da.relationship_type = 'program'
      WHERE d.workspace_id = 'f715a723-8fc9-4371-87ad-b250d7777e55'::uuid AND d.document_type = 'project'
        AND (d.visibility = 'workspace' OR d.created_by = '824e5ca9-c797-4bde-bb30-3fa8835c6a5a'::uuid OR TRUE = TRUE)
     AND d.archived_at IS NULL ORDER BY ((COALESCE((d.properties->>'impact')::int, 3) * COALESCE((d.properties->>'confidence')::int, 3) * COALESCE((d.properties->>'ease')::int, 3))) DESC;

\echo ==================== Q8 /api/programs list ====================
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
      SELECT d.id, d.title, d.properties, d.archived_at, d.created_at, d.updated_at,
             COALESCE((d.properties->>'owner_id')::uuid, d.created_by) as owner_id,
             u.name as owner_name, u.email as owner_email,
             (SELECT COUNT(*) FROM documents i
              JOIN document_associations da ON da.document_id = i.id AND da.related_id = d.id AND da.relationship_type = 'program'
              WHERE i.document_type = 'issue') as issue_count,
             (SELECT COUNT(*) FROM documents s
              JOIN document_associations da ON da.document_id = s.id AND da.related_id = d.id AND da.relationship_type = 'program'
              WHERE s.document_type = 'sprint') as sprint_count
      FROM documents d
      LEFT JOIN users u ON u.id = COALESCE((d.properties->>'owner_id')::uuid, d.created_by)
      WHERE d.workspace_id = 'f715a723-8fc9-4371-87ad-b250d7777e55'::uuid AND d.document_type = 'program'
        AND (d.visibility = 'workspace' OR d.created_by = '824e5ca9-c797-4bde-bb30-3fa8835c6a5a'::uuid OR TRUE = TRUE)
     AND d.archived_at IS NULL ORDER BY d.created_at DESC;

\echo ==================== Q9 search mentions - title ILIKE %auth% ====================
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
      SELECT id, title, document_type, visibility
       FROM documents
       WHERE workspace_id = 'f715a723-8fc9-4371-87ad-b250d7777e55'::uuid
         AND document_type IN ('wiki', 'issue', 'project', 'program')
         AND deleted_at IS NULL
         AND title ILIKE '%auth%'
         AND (visibility = 'workspace' OR created_by = '824e5ca9-c797-4bde-bb30-3fa8835c6a5a'::uuid OR TRUE = TRUE)
       ORDER BY
         CASE document_type
           WHEN 'issue' THEN 1 WHEN 'wiki' THEN 2 WHEN 'project' THEN 3 WHEN 'program' THEN 4 ELSE 5 END,
         updated_at DESC
       LIMIT 10;

\echo ==================== Q10 MAX(ticket_number) on issue create ====================
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT COALESCE(MAX(ticket_number), 0) + 1 as next_number
FROM documents
WHERE workspace_id = 'f715a723-8fc9-4371-87ad-b250d7777e55'::uuid AND document_type = 'issue';

\echo ==================== Q11 api_tokens.token_hash lookup (Bearer auth) ====================
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
    SELECT t.id, t.user_id, t.workspace_id, t.expires_at, t.revoked_at, u.is_super_admin
     FROM api_tokens t
     JOIN users u ON t.user_id = u.id
     WHERE t.token_hash = 'deadbeef';

\echo ==================== Q12 /api/documents full list (command palette + shell) ====================
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, workspace_id, document_type, title, parent_id, position, ticket_number, properties, created_at, updated_at, created_by, visibility
FROM documents
WHERE workspace_id = 'f715a723-8fc9-4371-87ad-b250d7777e55'::uuid AND archived_at IS NULL AND deleted_at IS NULL
  AND (visibility = 'workspace' OR created_by = '824e5ca9-c797-4bde-bb30-3fa8835c6a5a'::uuid OR TRUE = TRUE)
ORDER BY position ASC, created_at ASC;
