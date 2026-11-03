#!/usr/bin/env bash
#
# Run every browser probe against a local server.
#
# The browser probes are the half of the verification that unit tests
# cannot do: that the chart is actually painted, that the treemap tiles
# do not overlap, that clicking a row changes the visible selection.
#
# They need Playwright, which is NOT a project dependency — it lives in the
# toolchain venv:
#
#   export PLAYWRIGHT_BROWSERS_PATH=/opt/data/.toolchain/pw-browsers
#
# Usage:
#   test/browser/run-all.sh [url]
#
# With no URL it starts a server on port 8765, runs the probes against it
# and stops it again.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
URL="${1:-}"
PORT=8765
PY="${PY:-/opt/data/.toolchain/browser-venv/bin/python}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/data/.toolchain/pw-browsers}"

SERVER_PID=""
if [ -z "$URL" ]; then
  URL="http://127.0.0.1:${PORT}/"
  echo "starting a server on port ${PORT}..."
  (cd "$ROOT" && python3 -m http.server "$PORT" --bind 127.0.0.1) >/dev/null 2>&1 &
  SERVER_PID=$!
  # Wait for it to answer before pointing a browser at it.
  for _ in $(seq 1 20); do
    if curl -fsS -o /dev/null "$URL"; then break; fi
    sleep 0.5
  done
fi

FAILED=0
for probe in tabs_probe fx_probe heatmap_probe interactions; do
  echo
  echo "=== ${probe} ==="
  if ! "$PY" "$HERE/${probe}.py" "$URL"; then
    FAILED=1
  fi
done

if [ -n "$SERVER_PID" ]; then
  kill "$SERVER_PID" 2>/dev/null
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "all browser probes passed"
else
  echo "SOME BROWSER PROBES FAILED"
fi
exit "$FAILED"
