/*
 * Tests for the market tables model.
 *
 * The model owns the grouping and sorting logic behind the instrument
 * tables (Global Indices, Movers, Crypto & FX). Keeping it pure means the
 * ordering rules are verified without a browser.
 *
 * Run with: npm test   (node --test, no dependencies)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../assets/market-tables-model.js');

const UNIVERSE = [
  { symbol: '^GSPC', name: 'S&P 500', group: 'index' },
  { symbol: '^VIX', name: 'CBOE Volatility', group: 'index' },
  { symbol: 'AAPL', name: 'Apple', group: 'equity' },
  { symbol: 'BTC-USD', name: 'Bitcoin', group: 'crypto' },
  { symbol: 'EURUSD=X', name: 'Euro / US Dollar', group: 'fx' }
];

const QUOTES = {
  '^GSPC': { symbol: '^GSPC', name: 'Yahoo S&P 500', price: 5200, change: 20, changePct: 0.4, volume: 100 },
  '^VIX': { symbol: '^VIX', name: 'Volatility', price: 15.2, change: -1.1, changePct: -6.7, volume: 50 },
  'AAPL': { symbol: 'AAPL', name: 'Apple Inc', price: 344, change: -4, changePct: -1.2, volume: 900 },
  'BTC-USD': { symbol: 'BTC-USD', name: 'Bitcoin', price: 60000, change: 600, changePct: 1.0, volume: 20 },
  'EURUSD=X': { symbol: 'EURUSD=X', name: 'Euro', price: 1.08, change: 0.002, changePct: 0.2, volume: 7 }
};

// ---------------------------------------------------------------- toRow

test('toRow: prefers the curated universe name over the feed name', () => {
  const row = model.toRow(QUOTES['^GSPC'], UNIVERSE[0]);
  assert.equal(row.name, 'S&P 500');
  assert.equal(row.group, 'index');
});

test('toRow: falls back to the feed name when there is no universe entry', () => {
  const row = model.toRow({ symbol: 'ZZZZ', name: 'Some Co' }, null);
  assert.equal(row.name, 'Some Co');
  assert.equal(row.group, 'equity');
});

test('toRow: missing numbers become null, never undefined', () => {
  const row = model.toRow({ symbol: 'ZZZZ' }, null);
  assert.equal(row.price, null);
  assert.equal(row.change, null);
  assert.equal(row.changePct, null);
  assert.equal(row.dayLow, null);
  assert.equal(row.dayHigh, null);
  assert.equal(row.volume, null);
  assert.deepEqual(row.closes, []);
});

// ------------------------------------------------------------ buildRows

test('buildRows: returns only the requested group', () => {
  const rows = model.buildRows(QUOTES, UNIVERSE, 'index');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.symbol).sort(), ['^GSPC', '^VIX']);
});

test('buildRows: accepts a list of groups', () => {
  const rows = model.buildRows(QUOTES, UNIVERSE, ['crypto', 'fx']);
  assert.deepEqual(rows.map(r => r.symbol).sort(), ['BTC-USD', 'EURUSD=X']);
});

test('buildRows: with no group filter it returns everything', () => {
  assert.equal(model.buildRows(QUOTES, UNIVERSE, null).length, 5);
});

test('buildRows: no quotes means no rows', () => {
  assert.deepEqual(model.buildRows({}, UNIVERSE, 'index'), []);
  assert.deepEqual(model.buildRows(null, UNIVERSE, 'index'), []);
});

// ------------------------------------------------------------- sortRows

test('sortRows: sorts numbers ascending and descending', () => {
  const rows = model.buildRows(QUOTES, UNIVERSE, null);
  const asc = model.sortRows(rows, 'changePct', true).map(r => r.changePct);
  const desc = model.sortRows(rows, 'changePct', false).map(r => r.changePct);
  assert.deepEqual(asc, asc.slice().sort((a, b) => a - b));
  assert.deepEqual(desc, asc.slice().reverse());
});

test('sortRows: sorts strings with localeCompare, not codepoint order', () => {
  const rows = [
    { symbol: '^VIX', name: 'V' },
    { symbol: '^GSPC', name: 'S' },
    { symbol: 'AAPL', name: 'A' }
  ];
  const sorted = model.sortRows(rows, 'name', true).map(r => r.name);
  assert.deepEqual(sorted, ['A', 'S', 'V']);
});

test('sortRows: rows with no value sort last regardless of direction', () => {
  const rows = [
    { symbol: 'A', changePct: null },
    { symbol: 'B', changePct: 1 },
    { symbol: 'C', changePct: null }
  ];
  assert.deepEqual(model.sortRows(rows, 'changePct', true).map(r => r.symbol), ['B', 'A', 'C']);
  assert.deepEqual(model.sortRows(rows, 'changePct', false).map(r => r.symbol), ['B', 'A', 'C']);
});

test('sortRows: does not mutate the input array', () => {
  const rows = model.buildRows(QUOTES, UNIVERSE, null);
  const before = rows.map(r => r.symbol);
  model.sortRows(rows, 'symbol', false);
  assert.deepEqual(rows.map(r => r.symbol), before);
});

// ----------------------------------------------------------- buildMovers

test('buildMovers: gainers are the biggest risers, losers the biggest fallers', () => {
  const m = model.buildMovers(QUOTES, UNIVERSE, 5);
  assert.equal(m.gainers[0].symbol, 'BTC-USD');
  assert.equal(m.losers[0].symbol, '^VIX');
});

test('buildMovers: excludes FX pairs', () => {
  const m = model.buildMovers(QUOTES, UNIVERSE, 5);
  const all = [...m.gainers, ...m.losers, ...m.active].map(r => r.symbol);
  assert.ok(!all.includes('EURUSD=X'), 'FX pair leaked into the movers');
});

test('buildMovers: limits each list to the requested count', () => {
  const m = model.buildMovers(QUOTES, UNIVERSE, 2);
  assert.equal(m.gainers.length, 2);
  assert.equal(m.losers.length, 2);
  assert.equal(m.active.length, 2);
});

test('buildMovers: most active is ordered by volume', () => {
  const m = model.buildMovers(QUOTES, UNIVERSE, 5);
  assert.equal(m.active[0].symbol, 'AAPL');
});

test('buildMovers: a quote with no change cannot be a gainer or a loser', () => {
  const quotes = Object.assign({}, QUOTES, {
    'FLAT': { symbol: 'FLAT', name: 'Flat Co', price: 10, change: null, changePct: null, volume: 1 }
  });
  const m = model.buildMovers(quotes, UNIVERSE, 5);
  const movers = [...m.gainers, ...m.losers].map(r => r.symbol);
  assert.ok(!movers.includes('FLAT'), 'a flat quote was ranked as a mover');
});

test('buildMovers: no quotes means empty lists, not a crash', () => {
  const m = model.buildMovers({}, UNIVERSE, 5);
  assert.deepEqual(m.gainers, []);
  assert.deepEqual(m.losers, []);
  assert.deepEqual(m.active, []);
});
