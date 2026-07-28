\echo ==================== Q1 /api/issues list (unfiltered) ====================
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
      SELECT d.id, d.title, d.properties, d.ticket_number,
             d.content,
             d.created_at, d.updated_at, d.created_by,
             d.started_at, d.completed_at, d.cancelled_at, d.reopened_at,
             d.converted_from_id,
             u.name as assignee_name,
             CASE WHEN person_doc.archived_at IS NOT NULL THEN true ELSE false END as assignee_archived
      FROM documents d
      LEFT JOIN users u ON (d.properties->>'assignee_id')::uuid = u.id
      LEFT JOIN documents person_doc ON person_doc.workspace_id = d.workspace_id
        AND person_doc.document_type = 'person'
        AND person_doc.properties->>'user_id' = d.properties->>'assignee_id'
      WHERE d.workspace_id = 'f715a723-8fc9-4371-87ad-b250d7777e55'::uuid AND d.document_type = 'issue'
        AND (d.visibility = 'workspace' OR d.created_by = '824e5ca9-c797-4bde-bb30-3fa8835c6a5a'::uuid OR TRUE = TRUE)
        AND d.archived_at IS NULL AND d.deleted_at IS NULL
      ORDER BY d.created_at DESC;

\echo ==================== Q2 /api/issues filtered by properties->>'state' ====================
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
      SELECT d.id, d.title
      FROM documents d
      WHERE d.workspace_id = 'f715a723-8fc9-4371-87ad-b250d7777e55'::uuid AND d.document_type = 'issue'
        AND d.archived_at IS NULL AND d.deleted_at IS NULL
        AND d.properties->>'state' = ANY(ARRAY['in_progress','todo']);

\echo ==================== Q3 filter by properties->>'priority' ====================
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT d.id FROM documents d
WHERE d.workspace_id='f715a723-8fc9-4371-87ad-b250d7777e55'::uuid AND d.document_type='issue'
  AND d.properties->>'priority' = 'urgent';

\echo ==================== Q4 filter by properties->>'assignee_id' ====================
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT d.id FROM documents d
WHERE d.workspace_id='f715a723-8fc9-4371-87ad-b250d7777e55'::uuid AND d.document_type='issue'
  AND d.properties->>'assignee_id' = '824e5ca9-c797-4bde-bb30-3fa8835c6a5a';

\echo ==================== Q5 filter by properties->>'source' ====================
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT d.id FROM documents d
WHERE d.workspace_id='f715a723-8fc9-4371-87ad-b250d7777e55'::uuid AND d.document_type='issue'
  AND d.properties->>'source' = 'internal';

\echo ==================== Q6 CONTROL: containment @> (can use jsonb_ops GIN) ====================
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT d.id FROM documents d
WHERE d.properties @> '{"state":"in_progress"}'::jsonb;
