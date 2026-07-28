SET enable_seqscan = off;
\echo ==================== FORCED: ->> state  (seqscan disabled) ====================
EXPLAIN (ANALYZE, COSTS OFF)
SELECT d.id FROM documents d WHERE d.properties->>'state' = 'in_progress';
\echo ==================== FORCED CONTROL: @> containment (seqscan disabled) ====================
EXPLAIN (ANALYZE, COSTS OFF)
SELECT d.id FROM documents d WHERE d.properties @> '{"state":"in_progress"}'::jsonb;
\echo ==================== FORCED: ->> priority (seqscan disabled) ====================
EXPLAIN (ANALYZE, COSTS OFF)
SELECT d.id FROM documents d WHERE d.properties->>'priority' = 'urgent';
\echo ==================== FORCED: ->> assignee_id (seqscan disabled) ====================
EXPLAIN (ANALYZE, COSTS OFF)
SELECT d.id FROM documents d WHERE d.properties->>'assignee_id' = '824e5ca9-c797-4bde-bb30-3fa8835c6a5a';
\echo ==================== FORCED: ->> source (seqscan disabled) ====================
EXPLAIN (ANALYZE, COSTS OFF)
SELECT d.id FROM documents d WHERE d.properties->>'source' = 'internal';
RESET enable_seqscan;
