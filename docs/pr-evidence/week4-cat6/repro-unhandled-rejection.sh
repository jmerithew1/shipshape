#!/usr/bin/env bash
# Gap 2 driver — capture one before/after transcript for the unhandled-rejection fix.
#
# Usage (from repo root, PostgreSQL from docker-compose.local.yml running):
#   ./docs/pr-evidence/week4-cat6/repro-unhandled-rejection.sh <transcript-name>
#
# For the "before" transcript, first restore the pre-fix entrypoint:
#   git show dd98511~1:api/src/index.ts > api/src/index.ts
# and afterwards: git checkout -- api/src/index.ts
#
# The server runs from SOURCE via tsx (api/dist is untouched) on PORT=3790.
# The repro wrapper fires the rejection 3 s after /health first answers and
# self-exits at ready+15 s; the process always ends on its own, so its output
# flushes completely. Server output and driver probes are kept in separate
# files and stitched at the end (two writers on one fd lose lines on Windows).
set -u
OUT="docs/pr-evidence/week4-cat6/${1:?transcript name required}"
PORT=3790
SRV_LOG=$(mktemp)
PROBE_LOG=$(mktemp)

PORT=$PORT pnpm -C api exec tsx ../docs/pr-evidence/week4-cat6/repro-unhandled-rejection.ts \
  > "$SRV_LOG" 2>&1 &
SERVER_PID=$!

probe() {
  local label="$1"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://localhost:$PORT/health") || code="no-response"
  echo "[driver] $label /health -> $code" >> "$PROBE_LOG"
}

# Wait (up to 30 s) for the server to come up, then probe around the rejection,
# which fires at ready+3 s.
ready=""
for _ in $(seq 1 60); do
  if curl -s -o /dev/null --max-time 1 "http://localhost:$PORT/health"; then ready=1; break; fi
  sleep 0.5
done
if [ -z "$ready" ]; then
  echo "[driver] server never became healthy" >> "$PROBE_LOG"
else
  probe "ready+0s (before rejection; rejection fires at ready+3s)"
  sleep 5;  probe "ready+5s (2s after rejection)"
  sleep 4;  probe "ready+9s (6s after rejection)"
fi

wait $SERVER_PID
echo "[driver] server process ended with exit code $?" >> "$PROBE_LOG"

{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) — repro-unhandled-rejection ==="
  echo "=== api/src/index.ts @ $(git hash-object api/src/index.ts) (git hash-object) ==="
  echo
  echo "--- server output ---"
  cat "$SRV_LOG"
  echo
  echo "--- health probes (from outside the process) ---"
  cat "$PROBE_LOG"
} > "$OUT"
rm -f "$SRV_LOG" "$PROBE_LOG"

echo "transcript written to $OUT"
