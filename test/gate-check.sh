#!/usr/bin/env bash
# Test the CI leak gate in BOTH directions.
#
# A gate that has only ever been seen to pass is untested — it may pass
# because it never matches anything. This runs the real gate logic from
# deploy.yml against a clean tree (must pass) and against a tree with a
# synthetic leak injected (must fail).
set -uo pipefail

cd "$(dirname "$0")/.."

PASS=0
FAIL=0

# The gate, extracted verbatim from .github/workflows/deploy.yml.
run_gate() {
  local target="$1"
  if grep -rnE '\$[0-9]' "$target" >/dev/null 2>&1; then
    return 1
  fi
  if grep -rniE '["'"'"']?(shares|quantity|units|costbasis|cost_basis|amount)["'"'"']?[[:space:]]*[:=]' "$target" >/dev/null 2>&1; then
    return 1
  fi
  if grep -rniE '(fwd|forward)[ _-]?p/?e["'"'"']?[[:space:]]*[:=]' "$target" >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

expect() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  PASS  $label"
    PASS=$((PASS+1))
  else
    echo "  FAIL  $label (expected $expected, got $actual)"
    FAIL=$((FAIL+1))
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== DIRECTION 1: clean tree must PASS ==="
cp assets/portfolio.js "$WORK/portfolio.js"
if run_gate "$WORK/portfolio.js"; then actual=pass; else actual=block; fi
expect "clean portfolio.js passes the gate" pass "$actual"

echo
echo "=== DIRECTION 2: injected leaks must BLOCK ==="

inject() {
  local name="$1" line="$2"
  cp assets/portfolio.js "$WORK/leak.js"
  printf '%s\n' "$line" >> "$WORK/leak.js"
  if run_gate "$WORK/leak.js"; then actual=pass; else actual=block; fi
  expect "$name is blocked" block "$actual"
}

inject "dollar amount"        "    { symbol: 'AAPL', role: 'x', sector: 'Tech', group: 'tech', weight: 5, cost: '\$400,000' },"
inject "share count field"    "    { symbol: 'AAPL', role: 'x', sector: 'Tech', group: 'tech', weight: 5, shares: 100 },"
inject "quantity field"       "    { symbol: 'AAPL', role: 'x', sector: 'Tech', group: 'tech', weight: 5, quantity: 42 },"
inject "units field"          "    { symbol: 'AAPL', role: 'x', sector: 'Tech', group: 'tech', weight: 5, units: 7 },"
inject "cost basis field"     "    { symbol: 'AAPL', role: 'x', sector: 'Tech', group: 'tech', weight: 5, costBasis: 250 },"
inject "amount field"         "    { symbol: 'AAPL', role: 'x', sector: 'Tech', group: 'tech', weight: 5, amount: 9000 },"
inject "forward P/E field"    "    { symbol: 'AAPL', role: 'x', sector: 'Tech', group: 'tech', weight: 5, forwardPE: 31.2 },"

echo
echo "=== DIRECTION 3: legitimate data must NOT be blocked ==="
# The regression this gate must not cause: a truthful 100% allocation weight
# and the file's own documentation comment are both legitimate.
cp assets/portfolio.js "$WORK/legit.js"
if run_gate "$WORK/legit.js"; then actual=pass; else actual=block; fi
expect "allocation weight of 100 is not treated as a balance" pass "$actual"

# The header comment names the excluded fields in prose. The gate must match
# value positions, not prose.
if grep -q 'cost basis' assets/portfolio.js; then
  echo "  NOTE  portfolio.js prose does mention 'cost basis' (gate must ignore it)"
fi

echo
echo "=== SUMMARY: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1
