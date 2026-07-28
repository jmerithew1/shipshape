#!/usr/bin/env bash
# Uncontended (c=1) baseline for all 5 endpoints, single login, one rate-limit window.
set -u
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
SD="C:/Users/merit/AppData/Local/Temp/claude/C--Users-merit-OneDrive-Desktop-openemr-base-clean/b393c457-c63f-4f54-ad08-ecdf98562e8c/scratchpad"
cd "$SD"; J="$SD/j_base.txt"; rm -f "$J"

for i in 1 2 3 4 5; do
  HDR=$(curl -s -D - -o /dev/null http://127.0.0.1:3000/api/csrf-token)
  REM=$(echo "$HDR"|grep -i '^ratelimit-remaining:'|tr -d '\r'|awk '{print $2}'); REM=${REM:-0}
  RST=$(echo "$HDR"|grep -i '^ratelimit-reset:'|tr -d '\r'|awk '{print $2}'); RST=${RST:-60}
  [ "$REM" -ge 950 ] && break
  echo "  (budget $REM, wait $((RST+3))s)"; sleep $((RST+3))
done

TOK=$(curl -s -c "$J" -b "$J" http://127.0.0.1:3000/api/csrf-token | sed -E 's/.*"token":"([^"]+)".*/\1/')
curl -s -c "$J" -b "$J" -X POST http://127.0.0.1:3000/api/auth/login -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $TOK" -d '{"email":"dev@ship.local","password":"admin123"}' -o /dev/null
SID=$(grep session_id "$J" | awk '{print $7}' | tr -d '\r\n ')
[ -z "$SID" ] && { echo "LOGIN FAILED"; exit 1; }

for spec in "issues:/api/issues" "projects:/api/projects" "action-items:/api/accountability/action-items" \
            "my-week:/api/dashboard/my-week" "ctl-auth-me:/api/auth/me"; do
  n=${spec%%:*}; p=${spec#*:}
  printf "%-14s " "$n"
  node loadgen.js "$p" 1 90 "$SID" 10
done
