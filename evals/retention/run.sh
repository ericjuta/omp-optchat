#!/usr/bin/env bash
# Runs the retention and view-size cells of evals/retention/prereg-20261125.md, in order, under one total dollar budget.
#
#   evals/retention/run.sh <total-budget-usd> <out-dir> <seed>...
#
# A cell starts only when its whole worst-case cap (the runner's --max-cost-usd) fits what is left of the budget, so
# observed spend cannot pass the budget. A failed or stopped cell ends the script. Finished cells are kept and skipped
# on a rerun. RETENTION_FIXTURE=1 runs the same cells on the loopback fixture models: no provider call, no spend.
set -euo pipefail
shopt -s nullglob

budget=${1:?total budget in USD}
out=${2:?output directory}
shift 2
(($# > 0)) || { echo "give at least one seed" >&2; exit 2; }
root=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$out"

if [[ ${RETENTION_FIXTURE:-} == 1 ]]; then
	models=(--fixture-provider --main optchat-smoke/optchat-smoke-chat --compressor optchat-smoke/optchat-smoke-compact)
else
	models=(--confirm-live-provider-calls --main anthropic/claude-sonnet-5-5 --compressor anthropic/claude-haiku-5-5)
fi

# cell <name> <cap-usd> <records> <runner arguments...>
cell() {
	local name=$1 cap=$2 records=$3
	shift 3
	local file="$out/cell-$name.json"
	if [[ -e $file ]]; then
		echo "kept $name"
		return
	fi
	if [[ -e $file.started ]]; then
		echo "stop: an earlier attempt at $name left no artifact, so its spend is unknown" >&2
		exit 3
	fi
	local artifacts=("$out"/cell-*.json) spent=0
	if ((${#artifacts[@]} > 0)); then
		spent=$(jq -s 'map(.limits.spentUsd) | if all(type == "number") then add else error("a finished cell has unobserved spend") end' "${artifacts[@]}")
	fi
	if ! jq -en --argjson budget "$budget" --argjson spent "$spent" --argjson cap "$cap" '$spent + $cap <= $budget' >/dev/null; then
		echo "stop before $name: \$$spent spent, and its \$$cap cap does not fit the \$$budget budget" >&2
		exit 3
	fi
	echo "run $name: \$$spent spent so far, cap \$$cap"
	: >"$file.started"
	bun run "$root/scripts/evidence-recall.ts" "${models[@]}" --max-cost-usd "$cap" \
		--turn-mode per-question --question-emphasis adversarial --projects 6 --questions 24 \
		--min-source-bytes 1024 --sources "$records" --seed "$seed" \
		--max-calls 2000 --deadline-ms 1800000 --compressor-share 0.25 --out "$file" "$@" >"$out/cell-$name.log" 2>&1
	rm "$file.started"
}

for seed in "$@"; do
	# The largest cap goes first, so a budget that cannot finish the seed stops before it spends on the seed's other cells.
	cell "s$seed-512-off" 12 512 --arms off
	cell "s$seed-512-on-128000" 8 512 --arms on --view-bytes 128000
	cell "s$seed-512-on-64000" 8 512 --arms on --view-bytes 64000
	cell "s$seed-128-off" 5 128 --arms off
	cell "s$seed-128-on-128000" 8 128 --arms on --view-bytes 128000
	cell "s$seed-48-off" 3 48 --arms off
	cell "s$seed-48-on-128000" 8 48 --arms on --view-bytes 128000
done

bun run "$root/scripts/evidence-retention.ts" --out "$out/report.json" --force "$out"/cell-*.json | tee "$out/report.md"
