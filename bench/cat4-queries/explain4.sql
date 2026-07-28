\echo ==================== Q13 GET /api/programs/:id/sprints (8 correlated subplans per sprint row) ====================
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT d.id, d.title as name, d.properties,
       u.id as owner_id, u.name as owner_name, u.email as owner_email,
       (SELECT COUNT(*) FROM documents i
        JOIN document_associations ida ON ida.document_id = i.id AND ida.related_id = d.id AND ida.relationship_type = 'sprint'
        WHERE i.document_type = 'issue') as issue_count,
       (SELECT COUNT(*) FROM documents i
        JOIN document_associations ida ON ida.document_id = i.id AND ida.related_id = d.id AND ida.relationship_type = 'sprint'
        WHERE i.document_type = 'issue' AND i.properties->>'state' = 'done') as completed_count,
       (SELECT COUNT(*) FROM documents i
        JOIN document_associations ida ON ida.document_id = i.id AND ida.related_id = d.id AND ida.relationship_type = 'sprint'
        WHERE i.document_type = 'issue' AND i.properties->>'state' IN ('in_progress', 'in_review')) as started_count,
       (SELECT COALESCE(SUM((i.properties->>'estimate')::numeric), 0) FROM documents i
        JOIN document_associations ida ON ida.document_id = i.id AND ida.related_id = d.id AND ida.relationship_type = 'sprint'
        WHERE i.document_type = 'issue') as total_estimate_hours,
       (SELECT COUNT(*) > 0 FROM documents p WHERE p.parent_id = d.id AND p.document_type = 'weekly_plan') as has_plan,
       (SELECT COUNT(*) > 0 FROM documents r WHERE r.parent_id = d.id AND r.document_type = 'weekly_retro') as has_retro,
       (SELECT created_at FROM documents p WHERE p.parent_id = d.id AND p.document_type = 'weekly_plan' LIMIT 1) as plan_created_at,
       (SELECT created_at FROM documents r WHERE r.parent_id = d.id AND r.document_type = 'weekly_retro' LIMIT 1) as retro_created_at
FROM documents d
JOIN document_associations da ON da.document_id = d.id AND da.related_id = '6a99ef1c-0cf0-45ce-bc66-4babde44484e'::uuid AND da.relationship_type = 'program'
LEFT JOIN users u ON (d.properties->>'owner_id')::uuid = u.id
WHERE d.document_type = 'sprint'
  AND (d.visibility = 'workspace' OR d.created_by = '824e5ca9-c797-4bde-bb30-3fa8835c6a5a'::uuid OR TRUE = TRUE)
ORDER BY (d.properties->>'sprint_number')::int ASC;
