#!/bin/bash
# Regenerate all five Category-4 flow definitions, end to end, in one command.
#
# Resolves DOC_ID and SPRINT_ID from the database rather than taking them on
# faith. This matters: two of the five flows (document, weekboard) address a
# document by UUID, so their .urls files are SEED-SPECIFIC. After `pnpm db:seed`
# or any restore, the baked ids no longer exist, every request 404s, and the
# resulting query count is meaningless-but-plausible -- the worst kind of wrong.
# Re-run this after any re-seed, then re-measure.
#
# Requires: API + web dev servers running, and the seed volume from
# bench/README.md loaded. Does NOT need statement logging -- capture is separate
# from measurement, and only measurement needs the log.
#
#   bash bench/cat4-queries/run_capture.sh
#   API_PORT=3010 WEB=http://localhost:5173 bash bench/cat4-queries/run_capture.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
SD="$(cd "$(dirname "$0")" && pwd -W)"

API_PORT=${API_PORT:-3000}
API=${API:-http://localhost:${API_PORT}}
WEB=${WEB:-http://localhost:5173}
PG="docker exec shipshape-postgres-1 psql -U ship -d ship_dev -t -A"

pick() { # pick <document_type> -- oldest live document of that type
  $PG -c "SELECT id FROM documents
          WHERE document_type='$1' AND archived_at IS NULL AND deleted_at IS NULL
          ORDER BY created_at LIMIT 1;" | tr -d '\r\n '
}

DOC_ID=${DOC_ID:-$(pick wiki)}
SPRINT_ID=${SPRINT_ID:-$(pick sprint)}

[ -z "$DOC_ID" ]    && { echo "no wiki document found -- is ship_dev seeded?";   exit 1; }
[ -z "$SPRINT_ID" ] && { echo "no sprint document found -- is ship_dev seeded?"; exit 1; }

echo "API=${API}  WEB=${WEB}"
echo "DOC_ID=${DOC_ID}"
echo "SPRINT_ID=${SPRINT_ID}"
echo

DOC_ID="$DOC_ID" SPRINT_ID="$SPRINT_ID" API="$API" WEB="$WEB" \
  node "$SD/capture_flows.mjs"

echo
echo "Review 'git diff bench/cat4-queries/flows/' before committing."
echo "A changed call set is a real change in the app, not noise -- read it."
