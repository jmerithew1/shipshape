#!/usr/bin/env bash
# C3 destroy->apply-from-scratch drill on an ISOLATED stack (prod untouched).
# All credentials are read from the environment; none are stored in this file.
# Required env: RENDER_API_KEY, RENDER_OWNER_ID, TF_VAR_anthropic_api_key,
#               TF_VAR_langsmith_api_key
set -uo pipefail
cd /c/dev/shipshape/terraform/render-c3drill

: "${RENDER_API_KEY:?set RENDER_API_KEY}"
: "${RENDER_OWNER_ID:?set RENDER_OWNER_ID}"

EV=/c/dev/shipshape/evidence/2026-08-14/c3-drill
mkdir -p "$EV"

# Safety net: whatever happens, try to leave zero resources behind.
trap 'echo "[trap] ensuring teardown"; terraform destroy -auto-approve -input=false -no-color >> "$EV/trap-destroy.txt" 2>&1 || true' EXIT

health() { # $1=base url
  local i code
  for i in $(seq 1 24); do
    code=$(curl -s -o /tmp/c3h.txt -w "%{http_code}" "$1/health" 2>/dev/null || echo 000)
    echo "[health $i] $1/health -> $code $(cat /tmp/c3h.txt 2>/dev/null | head -c 120)"
    [ "$code" = "200" ] && return 0
    sleep 10
  done
  return 1
}

echo "########## PHASE A: apply (baseline, from scratch) ##########"
if ! terraform apply -auto-approve -input=false -no-color 2>&1 | tee "$EV/A-apply-baseline.txt"; then
  echo "APPLY A FAILED"; exit 1
fi
terraform output -no-color > "$EV/A-outputs.txt" 2>&1
API_A=$(terraform output -raw api_url 2>/dev/null)
echo "api_url A = $API_A" | tee "$EV/A-url.txt"
health "$API_A" | tee "$EV/A-health.txt" || echo "A health did not reach 200"

echo "########## PHASE B: destroy ##########"
terraform destroy -auto-approve -input=false -no-color 2>&1 | tee "$EV/B-destroy.txt"

echo "########## PHASE C: apply (rebuild from scratch) ##########"
if ! terraform apply -auto-approve -input=false -no-color 2>&1 | tee "$EV/C-apply-rebuild.txt"; then
  echo "APPLY C FAILED"; exit 1
fi
terraform output -no-color > "$EV/C-outputs.txt" 2>&1
API_C=$(terraform output -raw api_url 2>/dev/null)
echo "api_url C = $API_C" | tee "$EV/C-url.txt"
health "$API_C" | tee "$EV/C-health.txt" || echo "C health did not reach 200"

echo "########## PHASE E: final destroy (cleanup) ##########"
terraform destroy -auto-approve -input=false -no-color 2>&1 | tee "$EV/E-destroy-cleanup.txt"

echo "DRILL_COMPLETE"
