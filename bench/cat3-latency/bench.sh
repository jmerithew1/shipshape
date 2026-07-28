#!/usr/bin/env bash
# Category 3 audit harness. MEASURE ONLY.
# Rate limiter: 1000 req / 60s window, IP-keyed. Every measured run must fit
# inside ONE fresh window, else we benchmark 429s.
set -u
SD="C:/Users/merit/AppData/Local/Temp/claude/C--Users-merit-OneDrive-Desktop-openemr-base-clean/b393c457-c63f-4f54-ad08-ecdf98562e8c/scratchpad"
cd "$SD"
SID=$(cat sid.txt)
OUT="$SD/results"
mkdir -p "$OUT"
AMOUNT=700
WARM=150

# wait until the rate-limit window has enough budget
wait_budget () {
  local need=$1
  for i in $(seq 1 40); do
    local hdr rem reset
    hdr=$(curl -s -D - -o /dev/null -H "Cookie: session_id=$SID" http://localhost:3000/api/csrf-token)
    rem=$(echo "$hdr" | grep -i '^ratelimit-remaining:' | tr -d '\r' | awk '{print $2}')
    reset=$(echo "$hdr" | grep -i '^ratelimit-reset:' | tr -d '\r' | awk '{print $2}')
    rem=${rem:-0}; reset=${reset:-60}
    if [ "$rem" -ge "$need" ]; then echo "    budget ok (remaining=$rem)"; return 0; fi
    echo "    budget $rem < $need, sleeping $((reset+3))s"
    sleep $((reset+3))
  done
  return 1
}

run () {
  local name="$1" path="$2" conns="$3"
  local f="$OUT/${name}_c${conns}.json"
  echo "  [run] $name c=$conns"
  wait_budget $((AMOUNT+40)) || { echo "  BUDGET FAIL"; return 1; }
  npx --yes autocannon -c "$conns" -a "$AMOUNT" -p 1 \
    -H "Cookie: session_id=$SID" -j "http://localhost:3000$path" > "$f" 2>"$OUT/${name}_c${conns}.err"
  node -e '
    const r=require(process.argv[1]);
    const n=r.non2xx||0, e=r.errors||0, t=r["1xx"]+r["2xx"]+r["3xx"]+r["4xx"]+r["5xx"];
    console.log(`    p50=${r.latency.p50}ms p90=${r.latency.p90}ms p95=${r.latency.p95}ms p99=${r.latency.p99}ms avg=${r.latency.average.toFixed(1)} max=${r.latency.max} | rps=${r.requests.average.toFixed(0)} | 2xx=${r["2xx"]} non2xx=${n} err=${e} tot=${t} | bytes/req=${(r.throughput.total/(r["2xx"]||1)).toFixed(0)}`);
  ' "$f"
}

warm () {
  local name="$1" path="$2"
  echo "  [warm] $name"
  wait_budget $((WARM+40)) || return 1
  npx --yes autocannon -c 10 -a "$WARM" -p 1 -H "Cookie: session_id=$SID" \
    -j "http://localhost:3000$path" > "$OUT/${name}_warm.json" 2>/dev/null
}

# endpoint list: name|path  (filled by caller via endpoints.txt)
while IFS='|' read -r name path; do
  [ -z "${name:-}" ] && continue
  case "$name" in \#*) continue;; esac
  echo "=== $name  ($path) ==="
  warm "$name" "$path"
  for c in 10 25 50; do run "$name" "$path" "$c"; done
done < endpoints.txt

echo "ALL DONE"
