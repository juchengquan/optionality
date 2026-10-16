#!/usr/bin/env bash
# Ask both services the same question within the same second, and compare (ADR 0009, phase 6).
#
# The Python service is the live one on 31415. The TypeScript one is started here against a FRESH copy
# of the live database, on a port of its own, and stopped afterwards — it never writes to the live file.
#
# Bracketed: the Python is asked before and after, because both endpoints make a live OpenD call.
set -euo pipefail
cd "$(dirname "$0")/../../.."

OUT=backend/tools/opend/.out
PORT=${TS_PORT:-31419}
COPY=${TS_DB:-/tmp/optionality-compare.db}
mkdir -p "$OUT"
# API_TOKEN is not set in this deployment: the tailnet is the boundary (ADR 0006), and the bearer
# middleware is inert when the token is empty. Sending an empty header would be rejected if it were
# ever set, so the header is only added when there is one.
TOKEN=$(grep '^API_TOKEN=' .env 2>/dev/null | cut -d= -f2- || true)

rm -f "$COPY" "$COPY"-wal "$COPY"-shm "$COPY".snapshot*
node backend/tools/copy-db/copy.ts data/optionality.db "$COPY" >/dev/null

OPTIONALITY_DB_PATH="$COPY" PORT="$PORT" MONITOR_INTERVAL_SECONDS=3600 API_TOKEN= \
  node --env-file=.env backend/src/main.ts >"$OUT"/ts-service.log 2>&1 &
TS_PID=$!
trap 'kill -TERM $TS_PID 2>/dev/null || true' EXIT
sleep 4

# two branches rather than an array of arguments: macOS ships bash 3.2, where an empty array
# expanded under `set -u` is an unbound variable
ask_py() {
  if [ -n "$TOKEN" ]; then
    curl -s --max-time 15 -H "Authorization: Bearer $TOKEN" "$1"
  else
    curl -s --max-time 15 "$1"
  fi
}
ask_ts() { curl -s --max-time 15 "$1"; }
# every endpoint the dashboard reads, plus the two whose VALUES are compared below
ENDPOINTS="quotes positions/values monitors health"
for endpoint in $ENDPOINTS; do
  slug=${endpoint//\//_}
  ask_py "http://127.0.0.1:31415/$endpoint" > "$OUT/${slug}_py_before.json"
  ask_ts "http://127.0.0.1:$PORT/$endpoint" > "$OUT/${slug}_ts.json"
  ask_py "http://127.0.0.1:31415/$endpoint" > "$OUT/${slug}_py_after.json"
done

key_for()   { [ "$1" = "quotes" ] && echo code || echo name; }
# the least each endpoint should have compared, given the owner's four monitors and four positions
floor_for() { [ "$1" = "quotes" ] && echo 50 || echo 35; }
status=0
# values, where both sides compute from the same market: only the two endpoints that do
for endpoint in quotes positions/values; do
  slug=${endpoint//\//_}
  echo "/$endpoint values:"
  python3 backend/tools/opend/compare_quotes.py "$(key_for "$endpoint")" \
    "$OUT/${slug}_py_before.json" "$OUT/${slug}_ts.json" "$OUT/${slug}_py_after.json" \
    "$(floor_for "$endpoint")" | sed 's/^/  /' || status=1
done

# shapes, for everything the dashboard reads. Phase 8 types the frontend against the TypeScript
# service while it still TALKS to the Python one, so a field present in one and absent in the other is
# a blank cell in production on a branch whose typecheck passed.
for endpoint in $ENDPOINTS; do
  slug=${endpoint//\//_}
  echo "/$endpoint shape:"
  python3 backend/tools/opend/compare_shapes.py "$endpoint" \
    "$OUT/${slug}_py_before.json" "$OUT/${slug}_ts.json" | sed 's/^/  /' || status=1
done
exit $status
