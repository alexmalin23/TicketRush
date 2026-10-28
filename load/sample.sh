#!/usr/bin/env bash
# Samples resource use once a second while a scenario runs:  load/sample.sh <out.csv>
# Columns: time, container, cpu%, memory; then Postgres connections by state.
set -euo pipefail
out="${1:?usage: load/sample.sh <out.csv>}"
echo "t,container,cpu_pct,mem" > "$out"
pg="$(docker compose ps -q postgres)"
while true; do
  t="$(date +%s)"
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' | sed "s/^/$t,/" >> "$out"
  docker exec "$pg" psql -U postgres -Atc \
    "select '$t,pg_conn,'||coalesce(state,'none')||','||count(*) from pg_stat_activity where datname is not null group by state" >> "$out" || true
done
