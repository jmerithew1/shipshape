#!/usr/bin/env bash
# go.sh <name> <path> <conns> [amount] [warmup]
# Order matters: wait for a FRESH rate-limit window FIRST, then login, then measure.
set -u
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
# Repo-relative since 2026-07-29: the audit-era script pointed at a session
# scratchpad that no longer exists. Results land in out/ per the bench
# evidence convention; set LABEL (e.g. "rebaseline-<sha>") to tag the run.
SD="$(cd "$(dirname "$0")" && pwd)"
cd "$SD"; mkdir -p out
NAME=$1; PQ=$2; C=$3; AMOUNT=${4:-600}; WARM=${5:-40}
LABEL=${LABEL:-run}
J="$SD/j_run.txt"; rm -f "$J"

# 1. gate on a fresh window (unauthenticated, cheap)
for i in 1 2 3 4 5; do
  HDR=$(curl -s -D - -o /dev/null http://127.0.0.1:3000/api/csrf-token)
  REM=$(echo "$HDR"|grep -i '^ratelimit-remaining:'|tr -d '\r'|awk '{print $2}'); REM=${REM:-0}
  RST=$(echo "$HDR"|grep -i '^ratelimit-reset:'|tr -d '\r'|awk '{print $2}'); RST=${RST:-60}
  [ "$REM" -ge 950 ] && break
  echo "  (budget $REM, wait $((RST+3))s)"; sleep $((RST+3))
done

# 2. fresh session
TOK=$(curl -s -c "$J" -b "$J" http://127.0.0.1:3000/api/csrf-token | sed -E 's/.*"token":"([^"]+)".*/\1/')
curl -s -c "$J" -b "$J" -X POST http://127.0.0.1:3000/api/auth/login \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $TOK" \
  -d '{"email":"dev@ship.local","password":"admin123"}' -o /dev/null
SID=$(grep session_id "$J" | awk '{print $7}' | tr -d '\r\n ')
[ -z "$SID" ] && { echo "LOGIN FAILED"; exit 1; }

# 3. measure
node loadgen.js "$PQ" "$C" "$AMOUNT" "$SID" "$WARM" | tee "out/${LABEL}_${NAME}_c${C}.json"
