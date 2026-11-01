/*
 * Tests for the tabs model.
 *
 * The dashboard is one tabbed workspace. The switching rules — which tab is
 * active, what the keyboard does, what happens when a tab is asked for that
 * does not exist — live here so they can be verified without a browser.
 *
 * Run with: npm test   (node --test, no dependencies)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../assets/tabs-model.js');

test('the workspace knows its tabs in display order', () => {
  const keys = model.TABS.map((t) => t.key);
  assert.deepEqual(keys, [
    'indices', 'portfolio', 'heatmap', 'watchlist', 'movers', 'aux'
  ]);
});

test('the chart is not a tab', () => {
  // The chart sits above the tab bar and is always visible. Every table
  // below it selects the symbol the chart shows, so hiding the chart would
  // mean clicking a row had no visible result.
  assert.equal(model.isTab('chart'), false);
  assert.ok(!model.TABS.some((t) => t.key === 'chart'));
});

test('every tab carries the label shown on the button', () => {
  model.TABS.forEach((t) => {
    assert.equal(typeof t.label, 'string');
    assert.ok(t.label.length > 0, t.key + ' has no label');
  });
});

test('the first tab is the default', () => {
  assert.equal(model.defaultTab(), 'indices');
});

test('activating a tab returns that tab', () => {
  assert.equal(model.activate('heatmap'), 'heatmap');
  assert.equal(model.activate('aux'), 'aux');
});

test('activating an unknown tab keeps the current one', () => {
  assert.equal(model.activate('nope', 'movers'), 'movers');
  assert.equal(model.activate(undefined, 'movers'), 'movers');
  assert.equal(model.activate(null, 'movers'), 'movers');
  assert.equal(model.activate('', 'movers'), 'movers');
});

test('the next tab wraps around the end', () => {
  assert.equal(model.next('indices'), 'portfolio');
  assert.equal(model.next('portfolio'), 'heatmap');
  assert.equal(model.next('aux'), 'indices');
});

test('the previous tab wraps around the start', () => {
  assert.equal(model.next('aux'), 'indices');
  assert.equal(model.prev('aux'), 'movers');
  assert.equal(model.prev('indices'), 'aux');
});

test('keyboard navigation from an unknown tab falls back to the first', () => {
  assert.equal(model.next('bogus'), 'portfolio');
  assert.equal(model.prev('bogus'), 'aux');
});

test('only one tab can be active at a time', () => {
  // The guard against the classic bug: activating a tab must clear the
  // previous one, so two panels are never visible together.
  const state = { active: 'indices' };
  model.activateInto(state, 'heatmap');
  assert.equal(state.active, 'heatmap');
  assert.deepEqual(model.activeTabs(state), ['heatmap']);
});

test('activating into state with an unknown key changes nothing', () => {
  const state = { active: 'indices' };
  model.activateInto(state, 'bogus');
  assert.equal(state.active, 'indices');
  assert.deepEqual(model.activeTabs(state), ['indices']);
});

test('the model reports whether a tab is known', () => {
  assert.equal(model.isTab('heatmap'), true);
  assert.equal(model.isTab('bogus'), false);
});
