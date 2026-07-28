#!/usr/bin/env bash
# Drift-detection demo (hashicorp/local provider only - touches NOTHING in the ship repo).
# Captures raw output of every step into ./out/ for the audit record.
#
# Safe by construction: the only provider is hashicorp/local and the only
# resources are two files under ./managed/. No cloud credentials are used.

set -uo pipefail
cd "$(dirname "$0")"
mkdir -p out

run() { # run <label> <cmd...>
  local label="$1"; shift
  echo "########## $label ##########"
  echo "\$ $*"
  "$@" 2>&1 | tee "out/${label}.txt"
  echo "(exit=${PIPESTATUS[0]})"
  echo
}

run 01-version   terraform version
run 02-init      terraform init -no-color
run 03-fmt-check terraform fmt -check -no-color
run 04-validate  terraform validate -no-color
run 05-plan-initial terraform plan -no-color

# Apply is allowed HERE only: throwaway scratch config, local files only.
run 06-apply     terraform apply -auto-approve -no-color

echo "########## BEFORE: on-disk content of the managed file ##########"
cat managed/app-config.json | tee out/07-content-before.txt
echo; echo

run 08-plan-clean terraform plan -no-color   # expect: No changes.

echo "########## TAMPER: editing managed/app-config.json outside Terraform ##########"
# Simulate a human/console change: bump replicas 2 -> 9 and logLevel info -> debug
printf '%s' '{"env":"drift-demo","logLevel":"debug","replicas":9,"service":"ship-api"}' > managed/app-config.json
cat managed/app-config.json | tee out/09-content-after-tamper.txt
echo; echo

run 10-plan-drift terraform plan -no-color   # expect: 1 to change/replace (drift detected)

echo "########## DIFF: Terraform's clean plan vs drift plan ##########"
diff -u out/08-plan-clean.txt out/10-plan-drift.txt | tee out/11-plan-diff.txt
echo

echo "Raw outputs written to: $(pwd)/out"
