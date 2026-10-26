#!/usr/bin/env bash
# Runs one k6 scenario in Docker against the Compose stack:  npm run load -- <scenario> [k6 flags]
# The report (markdown + raw JSON) lands in load/results/.
set -euo pipefail
cd "$(dirname "$0")/.."

scenario="${1:-}"
if [[ -z "$scenario" || ! -f "load/scenarios/$scenario.js" ]]; then
  echo "usage: npm run load -- <scenario>   (available: $(ls load/scenarios | sed 's/\.js$//' | tr '\n' ' '))" >&2
  exit 1
fi
shift

# Machine info for the report. Docker's share matters most: the whole stack runs inside it.
if [[ "$(uname -s)" == "Darwin" ]]; then
  cpu="$(sysctl -n machdep.cpu.brand_string), $(sysctl -n hw.ncpu) cores"
  memory="$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 )) GB"
else
  cpu="$(lscpu | sed -n 's/^Model name:[[:space:]]*//p'), $(nproc) cores"
  memory="$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024 )) GB"
fi
IFS='|' read -r d_cpus d_mem d_version d_os <<< "$(docker info --format '{{.NCPU}}|{{.MemTotal}}|{{.ServerVersion}}|{{.OperatingSystem}}')"
docker_info="$d_cpus CPUs, $(( d_mem / 1024 / 1024 / 1024 )) GB, Docker $d_version ($d_os)"
commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)$(git diff --quiet 2>/dev/null || echo ' (uncommitted changes)')"

# A laptop that falls asleep mid-run freezes every in-flight request and makes the numbers meaningless.
keep_awake=()
if command -v caffeinate >/dev/null 2>&1; then keep_awake=(caffeinate -i); fi

power="unknown"
if command -v pmset >/dev/null 2>&1; then
  power="$(pmset -g batt | head -1 | sed -E "s/.*'(.*)'.*/\1/")" # "AC Power" or "Battery Power"
fi

mkdir -p load/results
"${keep_awake[@]}" docker compose --profile full --profile load run --rm \
  -e MACHINE_POWER="$power" \
  -e MACHINE_HOST="$(uname -sm)" \
  -e MACHINE_CPU="$cpu" \
  -e MACHINE_MEMORY="$memory" \
  -e MACHINE_DOCKER="$docker_info" \
  -e GIT_COMMIT="$commit" \
  k6 run --quiet "$@" "/load/scenarios/$scenario.js"
