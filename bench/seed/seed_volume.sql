-- seed_volume.sql — extend the seeded dataset to the Week-4 audit's required volume.
--
-- The assignment requires 500+ documents, 100+ issues, 20+ users, 10+ sprints before
-- API-latency and query-efficiency baselines are captured. `pnpm db:seed` produces
-- 257 documents and 11 users, so latency measured against it would understate real
-- behaviour. This script tops up ONLY volume; it changes no application code and no
-- schema. It is idempotent-ish: re-running adds another batch, so run once.
--
-- Usage:
--   docker exec -i shipshape-postgres-1 psql -U ship -d ship_dev < seed_volume.sql

BEGIN;

-- Anchor everything to the existing workspace + an existing author.
CREATE TEMP TABLE _ctx AS
SELECT
  (SELECT id FROM workspaces ORDER BY created_at LIMIT 1)              AS ws_id,
  (SELECT id FROM users WHERE email = 'dev@ship.local' LIMIT 1)        AS author_id;

-- ---------------------------------------------------------------------------
-- 1. Users: 11 -> 23 (requirement: 20+)
-- ---------------------------------------------------------------------------
INSERT INTO users (id, email, name, password_hash, created_at)
SELECT
  gen_random_uuid(),
  'loadtest' || i || '@ship.local',
  'Load Test User ' || i,
  -- bcrypt hash of 'admin123', reused from the existing seed so these accounts
  -- behave like real ones under auth benchmarking.
  (SELECT password_hash FROM users WHERE email = 'dev@ship.local'),
  now() - (i || ' days')::interval
FROM generate_series(1, 12) AS i
ON CONFLICT (email) DO NOTHING;

-- Make them workspace members so visibility/permission paths are exercised.
INSERT INTO workspace_memberships (id, workspace_id, user_id, role, created_at)
SELECT gen_random_uuid(), c.ws_id, u.id, 'member', now()
FROM users u CROSS JOIN _ctx c
WHERE u.email LIKE 'loadtest%@ship.local'
ON CONFLICT (workspace_id, user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Issues: +150 (exercises the JSONB ->> filter paths that lack a usable index)
-- ---------------------------------------------------------------------------
INSERT INTO documents (
  id, workspace_id, document_type, title, properties, ticket_number,
  created_by, visibility, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  c.ws_id,
  'issue',
  'Load test issue ' || i || ' — ' ||
    (ARRAY['auth','search','editor','sync','billing','reporting'])[1 + (i % 6)],
  jsonb_build_object(
    'state',       (ARRAY['triage','backlog','todo','in_progress','in_review','done','cancelled'])[1 + (i % 7)],
    'priority',    (ARRAY['low','medium','high','urgent'])[1 + (i % 4)],
    'source',      (ARRAY['internal','feedback'])[1 + (i % 2)],
    'assignee_id', (SELECT id::text FROM users ORDER BY md5(i::text || id::text) LIMIT 1),
    'estimate',    1 + (i % 13)
  ),
  (SELECT COALESCE(MAX(ticket_number), 0) FROM documents WHERE document_type = 'issue') + i,
  c.author_id,
  CASE WHEN i % 10 = 0 THEN 'private' ELSE 'workspace' END,
  now() - (i || ' hours')::interval,
  now() - (i || ' hours')::interval
FROM generate_series(1, 150) AS i CROSS JOIN _ctx c;

-- ---------------------------------------------------------------------------
-- 3. Wiki documents: +120, half of them nested (exercises the parent_id tree
--    and the circular-parent trigger on read paths)
-- ---------------------------------------------------------------------------
INSERT INTO documents (
  id, workspace_id, document_type, title, content,
  created_by, visibility, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  c.ws_id,
  'wiki',
  'Load test wiki page ' || i,
  jsonb_build_object(
    'type', 'doc',
    'content', jsonb_build_array(
      jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(
        jsonb_build_object('type', 'text',
          'text', 'Synthetic content for load testing. Page ' || i ||
                  '. Lorem ipsum dolor sit amet, consectetur adipiscing elit.')))
    )
  ),
  c.author_id,
  'workspace',
  now() - (i || ' hours')::interval,
  now() - (i || ' hours')::interval
FROM generate_series(1, 120) AS i CROSS JOIN _ctx c;

-- Nest ~half the new wiki pages one level deep.
WITH new_wiki AS (
  SELECT id, row_number() OVER (ORDER BY created_at) AS rn
  FROM documents
  WHERE document_type = 'wiki' AND title LIKE 'Load test wiki page %'
),
parents AS (SELECT id, rn FROM new_wiki WHERE rn <= 60)
UPDATE documents d
SET parent_id = p.id
FROM new_wiki n
JOIN parents p ON p.rn = n.rn - 60
WHERE d.id = n.id AND n.rn > 60;

-- ---------------------------------------------------------------------------
-- 4. Projects: +30, with ICE properties so scoring/sort paths are exercised
-- ---------------------------------------------------------------------------
INSERT INTO documents (
  id, workspace_id, document_type, title, properties,
  created_by, visibility, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  c.ws_id,
  'project',
  'Load test project ' || i,
  jsonb_build_object(
    'impact',     1 + (i % 5),
    'confidence', 1 + ((i + 1) % 5),
    'ease',       1 + ((i + 2) % 5),
    'status',     (ARRAY['not_started','in_progress','complete'])[1 + (i % 3)]
  ),
  c.author_id,
  'workspace',
  now() - (i || ' days')::interval,
  now() - (i || ' days')::interval
FROM generate_series(1, 30) AS i CROSS JOIN _ctx c;

-- ---------------------------------------------------------------------------
-- 5. Associate the new issues with existing projects via the junction table,
--    so belongs_to / JOIN-heavy list queries are realistically loaded.
-- ---------------------------------------------------------------------------
INSERT INTO document_associations (id, document_id, related_id, relationship_type, created_at)
SELECT
  gen_random_uuid(), i.id, p.id, 'project', now()
FROM (
  SELECT id, row_number() OVER (ORDER BY created_at) AS rn
  FROM documents WHERE document_type = 'issue' AND title LIKE 'Load test issue %'
) i
JOIN (
  SELECT id, row_number() OVER (ORDER BY created_at) AS rn
  FROM documents WHERE document_type = 'project'
) p ON p.rn = 1 + (i.rn % (SELECT count(*) FROM documents WHERE document_type = 'project'))
ON CONFLICT (document_id, related_id, relationship_type) DO NOTHING;

COMMIT;

-- Report the resulting volume against the requirement.
SELECT 'documents' AS metric, count(*) AS actual, 500 AS required FROM documents
UNION ALL SELECT 'issues',  count(*), 100 FROM documents WHERE document_type = 'issue'
UNION ALL SELECT 'users',   count(*), 20  FROM users
UNION ALL SELECT 'sprints', count(*), 10  FROM documents WHERE document_type = 'sprint';
