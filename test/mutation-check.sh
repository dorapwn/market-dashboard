#!/usr/bin/env bash
# Mutation check: prove the tests actually catch the bugs they claim to.
#
# A test suite that has only ever seen itself pass is untested. Each
# mutation below breaks one behaviour; the suite must go RED for it.
set -uo pipefail

cd "$(dirname "$0")/.."
PORTFOLIO_MODEL="assets/portfolio-model.js"
TABLES_MODEL="assets/market-tables-model.js"
BACKUP="$(mktemp)"
cp "$PORTFOLIO_MODEL" "$BACKUP.portfolio"
cp "$TABLES_MODEL" "$BACKUP.tables"

restore() {
  cp "$BACKUP.portfolio" "$PORTFOLIO_MODEL"
  cp "$BACKUP.tables" "$TABLES_MODEL"
  rm -f "$BACKUP.portfolio" "$BACKUP.tables"
}
trap restore EXIT

status=0

# mutate <name> <model-file> <pattern> <replacement>
mutate() {
  local name="$1" model="$2" pattern="$3" replacement="$4"
  local backup="$BACKUP.portfolio"
  if [ "$model" = "$TABLES_MODEL" ]; then backup="$BACKUP.tables"; fi

  cp "$backup" "$model"
  if ! node -e "
    const fs=require('fs');
    const p=process.argv[1];
    let s=fs.readFileSync(p,'utf8');
    const pat=process.argv[2], rep=process.argv[3];
    if(!s.includes(pat)){console.error('PATTERN NOT FOUND');process.exit(2);}
    fs.writeFileSync(p, s.replace(pat, rep));
  " "$model" "$pattern" "$replacement"; then
    echo "SKIP        $name (pattern not found — check the mutation still applies)"
    status=1
    return
  fi

  if node --test 'test/*.test.js' 2>&1 | grep -qE '^ℹ fail 0'; then
    echo "NOT CAUGHT  $name   <-- the test does not detect this"
    status=1
  else
    echo "CAUGHT      $name"
  fi
}

mutate "weighted move ignores weights (plain average)" \
  "$PORTFOLIO_MODEL" \
  "weightedSum / weightedBase" \
  "weightedSum / list.length"

mutate "mergeQuotes discards every chunk once one has failed" \
  "$PORTFOLIO_MODEL" \
  "succeeded++;
      chunk.forEach" \
  "if (failedChunks > 0) return;
      succeeded++;
      chunk.forEach"

mutate "validate stops rejecting sensitive fields" \
  "$PORTFOLIO_MODEL" \
  "if (SENSITIVE_KEYS.indexOf(norm) !== -1)" \
  "if (false)"

mutate "validate stops rejecting bad weight sums" \
  "$PORTFOLIO_MODEL" \
  "if (withWeight > 0 && Math.abs(weightSum - 100) > WEIGHT_SUM_TOLERANCE)" \
  "if (false)"

mutate "validate stops rejecting duplicate symbols" \
  "$PORTFOLIO_MODEL" \
  "} else if (seen[h.symbol]) {" \
  "} else if (false) {"

mutate "validate stops rejecting zero weights" \
  "$PORTFOLIO_MODEL" \
  "if (h.weight <= 0) {" \
  "if (false) {"

mutate "summarize counts every holding as tech" \
  "$PORTFOLIO_MODEL" \
  "if (h.group === 'tech') tech += h.weight;" \
  "tech += h.weight;"

mutate "trimCloses keeps the oldest points instead of the newest" \
  "$PORTFOLIO_MODEL" \
  "if (n && pts.length > n) return pts.slice(pts.length - n);" \
  "if (n && pts.length > n) return pts.slice(0, n);"

mutate "summarize returns a weighted move when nothing was quoted" \
  "$PORTFOLIO_MODEL" \
  "weightedMove: weightedBase > 0 ? round2(weightedSum / weightedBase) : null" \
  "weightedMove: weightedSum"

mutate "summarize fabricates an exposure percentage with no weights" \
  "$PORTFOLIO_MODEL" \
  "techExposure: hasWeights ? round2(tech) : null" \
  "techExposure: round2(tech)"

mutate "validate accepts a mix of weighted and unweighted holdings" \
  "$PORTFOLIO_MODEL" \
  "if (withWeight > 0 && withWeight < holdings.length) {" \
  "if (false) {"

# --- the instrument tables model -----------------------------------------

mutate "the tables model includes FX pairs in the movers lists" \
  "$TABLES_MODEL" \
  "var EXCLUDED_FROM_MOVERS = ['fx'];" \
  "var EXCLUDED_FROM_MOVERS = [];"

mutate "the tables model ranks a quote with no change as a mover" \
  "$TABLES_MODEL" \
  "return row.changePct !== null;" \
  "return true;"

mutate "the tables model sorts missing values first instead of last" \
  "$TABLES_MODEL" \
  "if (aMissing) return 1;" \
  "if (aMissing) return -1;"

mutate "the tables model sorts strings by codepoint instead of localeCompare" \
  "$TABLES_MODEL" \
  "return String(av).localeCompare(String(bv)) * dir;" \
  "return (String(av) < String(bv) ? -1 : 1) * dir;"

mutate "the tables model ignores the group filter" \
  "$TABLES_MODEL" \
  "return !!wanted[row.group];" \
  "return true;"

mutate "the tables model uses the feed name instead of the curated name" \
  "$TABLES_MODEL" \
  "name: (meta && meta.name) || q.name || q.symbol || ''," \
  "name: q.name || (meta && meta.name) || q.symbol || '',"

restore
trap - EXIT

echo
if [ "$status" -eq 0 ]; then
  echo "ALL MUTATIONS CAUGHT — the suite has teeth."
else
  echo "SOME MUTATIONS SURVIVED — the suite has holes."
fi
exit $status
