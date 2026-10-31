#!/usr/bin/env bash
# Mutation check: prove the tests actually catch the bugs they claim to.
#
# A test suite that has only ever seen itself pass is untested. Each
# mutation below breaks one behaviour; the suite must go RED for it.
set -uo pipefail

cd "$(dirname "$0")/.."
MODEL="assets/portfolio-model.js"
BACKUP="$(mktemp)"
cp "$MODEL" "$BACKUP"

restore() { cp "$BACKUP" "$MODEL"; rm -f "$BACKUP"; }
trap restore EXIT

status=0

mutate() {
  local name="$1" pattern="$2" replacement="$3"

  cp "$BACKUP" "$MODEL"
  if ! node -e "
    const fs=require('fs');
    const p=process.argv[1];
    let s=fs.readFileSync(p,'utf8');
    const pat=process.argv[2], rep=process.argv[3];
    if(!s.includes(pat)){console.error('PATTERN NOT FOUND');process.exit(2);}
    fs.writeFileSync(p, s.replace(pat, rep));
  " "$MODEL" "$pattern" "$replacement"; then
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
  "weightedSum / weightedBase" \
  "weightedSum / list.length"

mutate "mergeQuotes discards every chunk once one has failed" \
  "succeeded++;
      chunk.forEach" \
  "if (failedChunks > 0) return;
      succeeded++;
      chunk.forEach"

mutate "validate stops rejecting sensitive fields" \
  "if (SENSITIVE_KEYS.indexOf(norm) !== -1)" \
  "if (false)"

mutate "validate stops rejecting bad weight sums" \
  "if (Math.abs(weightSum - 100) > WEIGHT_SUM_TOLERANCE)" \
  "if (false)"

mutate "validate stops rejecting duplicate symbols" \
  "} else if (seen[h.symbol]) {" \
  "} else if (false) {"

mutate "validate stops rejecting zero weights" \
  "if (h.weight <= 0) {" \
  "if (false) {"

mutate "summarize counts every holding as tech" \
  "if (h.group === 'tech') tech += h.weight;" \
  "tech += h.weight;"

mutate "trimCloses keeps the oldest points instead of the newest" \
  "if (n && pts.length > n) return pts.slice(pts.length - n);" \
  "if (n && pts.length > n) return pts.slice(0, n);"

mutate "summarize returns a weighted move when nothing was quoted" \
  "weightedMove: weightedBase > 0 ? round2(weightedSum / weightedBase) : null" \
  "weightedMove: weightedSum"

restore
trap - EXIT

echo
if [ "$status" -eq 0 ]; then
  echo "ALL MUTATIONS CAUGHT — the suite has teeth."
else
  echo "SOME MUTATIONS SURVIVED — the suite has holes."
fi
exit $status
