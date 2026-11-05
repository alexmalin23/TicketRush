#!/usr/bin/env bash
# Samples one query's totals once a second while a scenario runs:  load/sample-queries.sh <out.csv> [text]
# Columns: epoch seconds, calls so far, execution ms so far. `text` picks the query (default: availability).
# Needs pg_stat_statements: docker compose -f docker-compose.yml -f docker/postgres/pg-stat-statements.yml ...
set -euo pipefail
out="${1:?usage: load/sample-queries.sh <out.csv> [text]}"
text="${2:-AS available}"
pg="$(docker compose ps -q postgres)"
docker exec "$pg" psql -U postgres -d modex -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements" >/dev/null
echo "t,calls,exec_ms" > "$out"
# One connection for the whole run: starting psql every second would itself load a throttled database.
docker exec -i "$pg" psql -U postgres -d modex -At -F, >> "$out" <<SQL
SELECT extract(epoch FROM clock_timestamp()), coalesce(sum(calls), 0), coalesce(sum(total_exec_time), 0)
  FROM pg_stat_statements WHERE query LIKE '%${text}%' AND query NOT LIKE '%pg_stat_statements%'
\watch 1
SQL
