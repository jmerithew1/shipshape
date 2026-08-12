#!/bin/bash
# usage: bearer_probe.sh [n_requests]
#
# Verifies the Week-6 `api/src/middleware/auth.ts` change on the ONLY surface it
# touches: the bearer-token path.
#
# Why this instrument exists: every existing Cat-3/Cat-4 instrument authenticates
# with a SESSION COOKIE (`loadgen.js` sends `Cookie: session_id=...`,
# `run_flow.sh` likewise). The Week-6 edit is inside `validateApiToken()`, which
# only runs for `Authorization: Bearer ...`. So none of the committed harness
# exercises it, and a session-cookie measurement can neither confirm nor refute
# the "fewer writes / faster" claim.
#
# What it measures: with log_statement='all' on, issue N back-to-back bearer
# requests and count (a) total queries and (b) `UPDATE api_tokens SET
# last_used_at` writes between markers.
#
# Expected: pre-change the UPDATE was unconditional -> N writes for N requests.
# Post-change it is throttled to 30s -> 1 write for N requests issued inside one
# 30s window. The token-lookup SELECT still runs once per request either way.
#
# Requires: log_statement='all' + log_min_duration_statement=0 (see
# AUDIT_REPORT.md Category 4) and a quiet system -- never run with a load test.
set -u
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
SD="$(cd "$(dirname "$0")" && pwd -W)"
cd "$SD"; mkdir -p out
N=${1:-10}
LABEL=${LABEL:-run}
PG="docker exec shipshape-postgres-1 psql -U ship -d ship_dev"
J="$SD/j_bearer.txt"; rm -f "$J"

# 1. Session login, to mint a token through the real route.
TOK=$(curl -s -c "$J" -b "$J" http://127.0.0.1:3000/api/csrf-token | sed -E 's/.*"token":"([^"]+)".*/\1/')
curl -s -c "$J" -b "$J" -X POST http://127.0.0.1:3000/api/auth/login \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $TOK" \
  -d '{"email":"dev@ship.local","password":"admin123"}' -o /dev/null
SID=$(grep session_id "$J" | awk '{print $7}' | tr -d '\r\n ')
[ -z "$SID" ] && { echo "LOGIN FAILED"; exit 1; }

# 2. Mint a bearer token. Unique name per run: the route 409s on a duplicate
#    active name, and a revoked leftover would otherwise block re-runs.
TNAME="bench-bearer-$(date +%s)"
BODY=$(curl -s -X POST http://127.0.0.1:3000/api/api-tokens \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $TOK" \
  -H "Cookie: session_id=${SID}" -b "$J" \
  -d "{\"name\":\"${TNAME}\"}")
BEARER=$(echo "$BODY" | sed -E 's/.*"token":"(ship_[^"]+)".*/\1/')
case "$BEARER" in ship_*) ;; *) echo "TOKEN MINT FAILED: $BODY"; exit 1 ;; esac
echo "minted ${TNAME}"

# 3. Bracketed burst of bearer-authenticated requests.
#
# A 3s gap is inserted mid-burst deliberately. Without it, all N requests land
# inside the same ~500ms and an unthrottled UPDATE would be indistinguishable
# from a throttled one by timestamp alone. With the gap, an unconditional write
# would leave last_used_at at the time of the LAST request; a 30s-throttled
# write leaves it pinned at the FIRST. That is the decisive observation.
LU() { $PG -t -A -c "SELECT COALESCE(last_used_at::text,'NULL') FROM api_tokens WHERE name='${TNAME}'" 2>/dev/null | tr -d '\r\n '; }

MARK="bearer_$(date +%s)"
$PG -c "SELECT 'ZZMARK_${MARK}_START'" >/dev/null 2>&1
HALF=$(( N / 2 )); [ "$HALF" -lt 1 ] && HALF=1
for i in $(seq 1 "$N"); do
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${BEARER}" \
    "http://localhost:3000/api/auth/me")
  echo "  req $i -> $code"
  if [ "$i" = "1" ]; then LU_FIRST=$(LU); echo "    last_used_at after req 1: ${LU_FIRST}"; fi
  if [ "$i" = "$HALF" ]; then echo "    (3s gap)"; sleep 3; fi
done
LU_LAST=$(LU)
$PG -c "SELECT 'ZZMARK_${MARK}_END'" >/dev/null 2>&1

echo
echo "--- last_used_at throttling ---"
echo "  after req 1 : ${LU_FIRST:-unset}"
echo "  after req ${N}: ${LU_LAST:-unset}"
if [ "${LU_FIRST:-x}" = "${LU_LAST:-y}" ]; then
  echo "  RESULT: UNCHANGED across ${N} requests spanning >3s -> write IS throttled"
else
  echo "  RESULT: ADVANCED -> write is NOT throttled (one UPDATE per request)"
fi
echo

docker logs shipshape-postgres-1 > "$SD/pglog_bearer.txt" 2>&1
echo "===== bearer x${N} ====="
python "$SD/parse.py" "ZZMARK_${MARK}_START" "ZZMARK_${MARK}_END" "$SD/pglog_bearer.txt" \
  | tee "out/${LABEL}_bearer.txt" | head -25

echo
echo "--- last_used_at writes in this window ---"
grep -c "UPDATE api_tokens SET last_used_at" "out/${LABEL}_bearer.txt" || true
