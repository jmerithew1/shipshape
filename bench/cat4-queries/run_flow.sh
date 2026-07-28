#!/bin/bash
# usage: run_flow.sh <flowname> <urlfile>
SP="/c/Users/merit/AppData/Local/Temp/claude/C--Users-merit-OneDrive-Desktop-openemr-base-clean/b393c457-c63f-4f54-ad08-ecdf98562e8c/scratchpad"
cd "$SP" || exit 1
NAME="$1"; URLFILE="$2"
PG="docker exec shipshape-postgres-1 psql -U ship -d ship_dev"
$PG -c "SELECT 'ZZMARK_${NAME}_START'" >/dev/null 2>&1
while IFS= read -r u; do
  [ -z "$u" ] && continue
  code=$(curl -s -o "resp_${NAME}.tmp" -w "%{http_code}" -b jar.txt "http://localhost:3000${u}")
  sz=$(wc -c < "resp_${NAME}.tmp")
  echo "  ${code}  ${sz}B  ${u}"
done < "$URLFILE"
$PG -c "SELECT 'ZZMARK_${NAME}_END'" >/dev/null 2>&1
docker logs shipshape-postgres-1 > pglog.txt 2>&1
echo "===== $NAME ====="
python parse.py "ZZMARK_${NAME}_START" "ZZMARK_${NAME}_END" pglog.txt
