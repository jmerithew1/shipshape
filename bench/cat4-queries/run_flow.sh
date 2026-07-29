#!/bin/bash
# usage: run_flow.sh <flowname> <urlfile>
# Counts exact DB queries for one user flow: brackets the flow with SQL marker
# statements, replays the flow's API calls with a fresh session, then counts
# log entries between markers with parse.py.
#
# Requires: log_statement='all' + log_min_duration_statement=0 on the container
# (see AUDIT_REPORT.md Category 4 methodology) and a quiet system -- never run
# concurrently with a load test.
#
# Repo-relative since 2026-07-29: the audit-era script pointed at a session
# scratchpad that no longer exists. Results land in out/ per the bench
# evidence convention; set LABEL (e.g. "rebaseline-<sha>") to tag the run.
set -u
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
# pwd -W: Windows-style path -- MSYS path conversion is disabled above, so a
# POSIX /c/... path would break curl's cookie jar (-c/-b).
SD="$(cd "$(dirname "$0")" && pwd -W)"
cd "$SD"; mkdir -p out
NAME="$1"; URLFILE="$2"
LABEL=${LABEL:-run}
PG="docker exec shipshape-postgres-1 psql -U ship -d ship_dev"
J="$SD/j_flow.txt"; rm -f "$J"

# fresh session (login limiter: only failed attempts count)
TOK=$(curl -s -c "$J" -b "$J" http://127.0.0.1:3000/api/csrf-token | sed -E 's/.*"token":"([^"]+)".*/\1/')
curl -s -c "$J" -b "$J" -X POST http://127.0.0.1:3000/api/auth/login \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $TOK" \
  -d '{"email":"dev@ship.local","password":"admin123"}' -o /dev/null
SID=$(grep session_id "$J" | awk '{print $7}' | tr -d '\r\n ')
[ -z "$SID" ] && { echo "LOGIN FAILED"; exit 1; }

# unique marker per run: the container log accumulates across runs, and a
# repeated marker name makes parse.py slice between mismatched pairs
MARK="${NAME}_$(date +%s)"
$PG -c "SELECT 'ZZMARK_${MARK}_START'" >/dev/null 2>&1
while IFS= read -r u; do
  [ -z "$u" ] && continue
  case "$u" in \#*) continue ;; esac
  # explicit Cookie header: the jar's cookie is scoped to 127.0.0.1 and would
  # not be sent to localhost (domain mismatch -> silent 401s)
  code=$(curl -s -o "out/resp_${NAME}.tmp" -w "%{http_code}" -H "Cookie: session_id=${SID}" "http://localhost:3000${u}")
  sz=$(wc -c < "out/resp_${NAME}.tmp")
  echo "  ${code}  ${sz}B  ${u}"
done < "$URLFILE"
$PG -c "SELECT 'ZZMARK_${MARK}_END'" >/dev/null 2>&1
rm -f "out/resp_${NAME}.tmp"
docker logs shipshape-postgres-1 > "$SD/pglog.txt" 2>&1
echo "===== $NAME ====="
python "$SD/parse.py" "ZZMARK_${MARK}_START" "ZZMARK_${MARK}_END" "$SD/pglog.txt" | tee "out/${LABEL}_${NAME}.txt"
