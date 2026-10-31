/*
 * Tests for the pure portfolio model.
 *
 * Run with: npm test   (node --test, no dependencies)
 *
 * The model is the only place portfolio *logic* lives, so it can be tested
 * without a browser. assets/app.js renders from these results.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../assets/portfolio-model.js');

const MSFT = { symbol: 'MSFT', role: 'Mega-cap software & cloud', sector: 'Tech', group: 'tech', weight: 100 };

test('validate: accepts a single holding at 100%', () => {
  const res = model.validate([MSFT]);
  assert.equal(res.ok, true, 'expected valid: ' + JSON.stringify(res.problems));
  assert.deepEqual(res.problems, []);
});

test('validate: rejects duplicate symbols', () => {
  const res = model.validate([MSFT, { ...MSFT, weight: 0 }]);
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => /duplicate/i.test(p)));
});

test('validate: rejects weights that do not sum to 100', () => {
  const res = model.validate([{ ...MSFT, weight: 60 }]);
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => /sum/i.test(p)));
});

test('validate: rejects a holding carrying a sensitive field', () => {
  const res = model.validate([{ ...MSFT, shares: 100 }]);
  assert.equal(res.ok, false);
  // The message must distinguish a known-private field from an unknown one,
  // so the next editor knows whether they leaked something or typo'd a key.
  assert.ok(
    res.problems.some((p) => /forbidden field/i.test(p) && /shares/i.test(p)),
    'expected a forbidden-field problem, got: ' + JSON.stringify(res.problems)
  );
});

test('validate: names an unknown field as unexpected, not forbidden', () => {
  const res = model.validate([{ ...MSFT, color: 'blue' }]);
  assert.equal(res.ok, false);
  assert.ok(
    res.problems.some((p) => /unexpected field/i.test(p) && /color/i.test(p)),
    'expected an unexpected-field problem, got: ' + JSON.stringify(res.problems)
  );
  assert.ok(
    !res.problems.some((p) => /forbidden/i.test(p)),
    'an unknown field must not be reported as private data: ' + JSON.stringify(res.problems)
  );
});

test('validate: rejects a non-positive weight', () => {
  // The weights still sum to 100, so this can only be caught by the
  // per-holding weight rule — not by the sum check.
  const res = model.validate([
    { ...MSFT, symbol: 'A', weight: 0 },
    { ...MSFT, symbol: 'B', weight: 100 }
  ]);
  assert.equal(res.ok, false);
  assert.ok(
    res.problems.some((p) => /greater than zero/i.test(p)),
    'expected a weight-range problem, got: ' + JSON.stringify(res.problems)
  );
});

test('summarize: one holding is 100% tech, 0% non-tech', () => {
  const s = model.summarize([MSFT], { MSFT: { changePct: 2.5 } });
  assert.equal(s.techExposure, 100);
  assert.equal(s.nonTechExposure, 0);
  assert.equal(s.holdingCount, 1);
});

test('summarize: weighted move follows the single holding', () => {
  const s = model.summarize([MSFT], { MSFT: { changePct: -1.25 } });
  assert.equal(s.weightedMove, -1.25);
});

test('summarize: weighted move ignores holdings with no quote', () => {
  const s = model.summarize([MSFT], {});
  assert.equal(s.weightedMove, null);
});

test('summarize: weighted move is weight-weighted, not a plain average', () => {
  const holdings = [
    { symbol: 'A', role: 'a', sector: 'Tech', group: 'tech', weight: 75 },
    { symbol: 'B', role: 'b', sector: 'Utility', group: 'nontech', weight: 25 }
  ];
  const s = model.summarize(holdings, { A: { changePct: 4 }, B: { changePct: -4 } });
  // (4*75 + -4*25) / 100 = 2, not the 0 a plain average would give.
  assert.equal(s.weightedMove, 2);
});

test('summarize: reports sector weights for the concentration strip', () => {
  const holdings = [
    { symbol: 'A', role: 'a', sector: 'Tech', group: 'tech', weight: 60 },
    { symbol: 'B', role: 'b', sector: 'Utility', group: 'nontech', weight: 40 }
  ];
  const s = model.summarize(holdings, {});
  assert.deepEqual(s.sectorWeights, { Tech: 60, Utility: 40 });
});

test('summarize: a single sector means no meaningful concentration strip', () => {
  const s = model.summarize([MSFT], {});
  assert.equal(s.showSectorStrip, false);
});

test('mergeQuotes: merges successful chunks', () => {
  const merged = model.mergeQuotes([
    [{ symbol: 'A', price: 1 }],
    [{ symbol: 'B', price: 2 }]
  ]);
  assert.deepEqual(Object.keys(merged.quotes).sort(), ['A', 'B']);
  assert.equal(merged.ok, true);
});

test('mergeQuotes: a failed chunk does not discard the others', () => {
  // This is the resilience bug: one chunk timing out must not blank the page.
  const merged = model.mergeQuotes([
    null,
    [{ symbol: 'B', price: 2 }]
  ]);
  assert.deepEqual(Object.keys(merged.quotes), ['B']);
  assert.equal(merged.ok, true);
  assert.equal(merged.failedChunks, 1);
});

test('mergeQuotes: a later failure does not wipe earlier successes', () => {
  // Regression guard: the merge must accumulate across chunks, so a
  // failure partway through cannot discard what already succeeded.
  const merged = model.mergeQuotes([
    [{ symbol: 'A', price: 1 }],
    null,
    [{ symbol: 'C', price: 3 }]
  ]);
  assert.deepEqual(Object.keys(merged.quotes).sort(), ['A', 'C']);
  assert.equal(merged.ok, true);
  assert.equal(merged.failedChunks, 1);
});

test('mergeQuotes: reports failure only when every chunk failed', () => {
  const merged = model.mergeQuotes([null, null]);
  assert.equal(merged.ok, false);
  assert.equal(merged.failedChunks, 2);
});

test('trimCloses: keeps the most recent points and drops nulls', () => {
  const out = model.trimCloses([1, null, 2, 3, 4], 3);
  assert.deepEqual(out, [2, 3, 4]);
});

test('trimCloses: an empty series stays empty', () => {
  assert.deepEqual(model.trimCloses(null, 5), []);
  assert.deepEqual(model.trimCloses([], 5), []);
});

test('snapshotChartData: builds a time axis from closes', () => {
  const out = model.snapshotChartData([10, 11, 12], 1000, 300);
  assert.deepEqual(out.closes, [10, 11, 12]);
  assert.equal(out.timestamps.length, 3);
  assert.equal(out.intraday, true);
});

test('snapshotChartData: the last timestamp is the quote time', () => {
  const out = model.snapshotChartData([10, 11, 12], 1000, 300);
  assert.equal(out.timestamps[2], 1000);
});

test('snapshotChartData: timestamps step backwards by the interval', () => {
  const out = model.snapshotChartData([10, 11, 12], 1000, 300);
  assert.equal(out.timestamps[0], 1000 - 600);
  assert.equal(out.timestamps[1], 1000 - 300);
});

test('snapshotChartData: returns null when there are too few points', () => {
  assert.equal(model.snapshotChartData([10], 1000, 300), null);
  assert.equal(model.snapshotChartData([], 1000, 300), null);
  assert.equal(model.snapshotChartData(null, 1000, 300), null);
});

test('snapshotChartData: returns null without a usable timestamp', () => {
  assert.equal(model.snapshotChartData([10, 11], 0, 300), null);
  assert.equal(model.snapshotChartData([10, 11], null, 300), null);
});

test('snapshotChartData: drops null closes before building the axis', () => {
  const out = model.snapshotChartData([10, null, 12], 1000, 300);
  assert.deepEqual(out.closes, [10, 12]);
  assert.equal(out.timestamps.length, 2);
  assert.equal(out.timestamps[1], 1000);
});
