/*
 * Tabs model — pure logic, shared by the browser and the tests.
 *
 * The dashboard is a single tabbed workspace: a row of tabs and one panel
 * visible at a time. The switching rules live here so they can be unit
 * tested without a browser.
 *
 * No DOM, no globals.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TabsModel = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * The tabs, in the order they are shown.
   *
   * The key matches the `data-tab` on the button and the `data-panel` on
   * the panel, so the markup drives the switch and the model only decides
   * what is valid.
   *
   * The chart is NOT a tab. It sits above the tab bar and is always
   * visible, because every table below it selects the symbol the chart
   * shows — hiding it would mean clicking a row had no visible result.
   */
  var TABS = [
    { key: 'indices',   label: 'Global Indices' },
    { key: 'portfolio', label: 'Portfolio' },
    { key: 'heatmap',   label: 'Heatmap' },
    { key: 'watchlist', label: 'Watchlist' },
    { key: 'movers',    label: 'Movers' },
    { key: 'aux',       label: 'FX & Crypto' }
  ];

  var KEYS = TABS.map(function (t) { return t.key; });

  function isTab(key) {
    return KEYS.indexOf(key) !== -1;
  }

  function defaultTab() {
    return KEYS[0];
  }

  /**
   * Resolve a requested tab against the current one.
   *
   * An unknown key is ignored rather than throwing: a stale bookmark or a
   * typo in the URL must not leave the workspace with no visible panel.
   */
  function activate(key, current) {
    if (isTab(key)) return key;
    return isTab(current) ? current : defaultTab();
  }

  /**
   * Move to the neighbouring tab, wrapping at both ends.
   */
  function next(key) {
    var i = KEYS.indexOf(key);
    if (i === -1) i = 0;
    return KEYS[(i + 1) % KEYS.length];
  }

  function prev(key) {
    var i = KEYS.indexOf(key);
    if (i === -1) i = 0;
    return KEYS[(i - 1 + KEYS.length) % KEYS.length];
  }

  /**
   * Set the active tab on a state object.
   *
   * The state carries the list of active tabs rather than a single key, so
   * a caller that renders from that list can never show two panels at once.
   */
  function activateInto(state, key) {
    var resolved = activate(key, state.active);
    state.active = resolved;
    state.activeTabs = [resolved];
    return resolved;
  }

  /**
   * The tabs that should be visible for a state.
   */
  function activeTabs(state) {
    var resolved = activate(state.active, defaultTab());
    return [resolved];
  }

  return {
    TABS: TABS,
    isTab: isTab,
    defaultTab: defaultTab,
    activate: activate,
    activateInto: activateInto,
    activeTabs: activeTabs,
    next: next,
    prev: prev
  };
});
