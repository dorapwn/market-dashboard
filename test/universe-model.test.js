/*
 * Tests for the tracked instrument universe.
 *
 * The universe is the single source of truth for which instruments the
 * dashboard follows. The browser fetches it, the snapshot script fetches
 * it, and CI checks that the committed snapshot covers all of it.
 *
 * A symbol added here but missing from the snapshot would simply vanish
 * from the page whenever Yahoo is unreachable — which is exactly the
 * failure mode this file guards against.
 *
 * Run with: npm test   (node --test, no dependencies)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const universe = require('../assets/universe.js');

const UNIVERSE = universe.UNIVERSE;

// ----------------------------------------------------------------- shape

test('the universe is not empty', () => {
  assert.ok(UNIVERSE.length > 0);
});

test('every entry has a symbol, a name and a group', () => {
  UNIVERSE.forEach((u) => {
    assert.equal(typeof u.symbol, 'string', JSON.stringify(u));
    assert.ok(u.symbol.length > 0, JSON.stringify(u));
    assert.equal(typeof u.name, 'string', JSON.stringify(u));
    assert.ok(u.name.length > 0, JSON.stringify(u));
    assert.equal(typeof u.group, 'string', JSON.stringify(u));
    assert.ok(u.group.length > 0, JSON.stringify(u));
  });
});

test('every symbol is unique', () => {
  const seen = new Set();
  const dupes = [];
  UNIVERSE.forEach((u) => {
    if (seen.has(u.symbol)) dupes.push(u.symbol);
    seen.add(u.symbol);
  });
  assert.deepEqual(dupes, []);
});

test('symbols() lists every symbol exactly once', () => {
  const syms = universe.symbols();
  assert.equal(syms.length, UNIVERSE.length);
  assert.equal(new Set(syms).size, syms.length);
});

// ------------------------------------------------------------------ groups

test('the universe covers indices, equities, crypto and FX', () => {
  const groups = new Set(universe.ofGroup(null).map((u) => u.group));
  ['index', 'equity', 'crypto', 'fx'].forEach((g) => {
    assert.ok(groups.has(g), 'missing group: ' + g);
  });
});

test('ofGroup filters by group', () => {
  const fx = universe.ofGroup('fx');
  assert.ok(fx.length > 0);
  fx.forEach((u) => assert.equal(u.group, 'fx'));
});

// --------------------------------------------------------------------- FX

test('the Hong Kong and Chinese Yuan pairs are tracked', () => {
  // Neo asked for these three by name.
  const wanted = ['HKDCNY=X', 'CNYHKD=X', 'USDHKD=X'];
  const fx = universe.ofGroup('fx').map((u) => u.symbol);
  wanted.forEach((s) => {
    assert.ok(fx.includes(s), s + ' is not tracked as an FX pair');
  });
});

test('the Hong Kong and Chinese Yuan pairs are in the fx group', () => {
  // They must be FX, not equity: the movers panel excludes FX because a
  // pair's percentage move is tiny next to an equity's, and a pair that
  // landed in the wrong group would flood the movers list.
  ['HKDCNY=X', 'CNYHKD=X', 'USDHKD=X'].forEach((s) => {
    const u = UNIVERSE.find((x) => x.symbol === s);
    assert.ok(u, s + ' is not in the universe');
    assert.equal(u.group, 'fx', s + ' is in the wrong group');
  });
});

test('every FX pair has a readable name', () => {
  universe.ofGroup('fx').forEach((u) => {
    assert.ok(u.name.length > 1, u.symbol + ' has a one-character name');
  });
});

// ----------------------------------------------------------------- crypto

test('every crypto symbol has a CoinGecko fallback id', () => {
  // Without an id, the crypto row disappears whenever Yahoo fails — the
  // fallback fetch would have nothing to ask for.
  universe.ofGroup('crypto').forEach((u) => {
    assert.equal(typeof universe.COINGECKO_IDS[u.symbol], 'string',
      u.symbol + ' has no CoinGecko id');
  });
});

test('every CoinGecko id belongs to a tracked crypto symbol', () => {
  const crypto = universe.ofGroup('crypto').map((u) => u.symbol);
  Object.keys(universe.COINGECKO_IDS).forEach((sym) => {
    assert.ok(crypto.includes(sym), sym + ' has an id but is not tracked');
  });
});
