/*
 * Market tables model — pure logic, shared by the browser and the tests.
 *
 * The instrument tables (Global Indices, Movers, Crypto & FX) are all the
 * same shape: take a set of quotes, group them, sort them, and render.
 * The grouping and ordering rules live here so they can be unit-tested
 * without a browser.
 *
 * No DOM, no fetch, no globals.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MarketTablesModel = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * The group a symbol belongs to when the curated universe does not
   * mention it. Equities are the bulk of the page, so they are the
   * sensible default.
   */
  var DEFAULT_GROUP = 'equity';

  /**
   * Groups that are never ranked as "movers".
   *
   * An FX pair's percentage change is a tiny number relative to an
   * equity's, so including them would fill the movers list with
   * instruments that barely moved.
   */
  var EXCLUDED_FROM_MOVERS = ['fx'];

  function isNum(v) {
    return v !== null && v !== undefined && typeof v === 'number' && isFinite(v);
  }

  function numOrNull(v) {
    return isNum(v) ? v : null;
  }

  /**
   * Build the display row for one quote.
   *
   * The curated universe name wins over the feed's own name: Yahoo calls
   * the S&P 500 "Yahoo S&P 500" and the Hang Seng "HSI", and neither is
   * what a reader wants to see.
   */
  function toRow(quote, meta) {
    var q = quote || {};
    return {
      symbol: q.symbol || (meta && meta.symbol) || '',
      name: (meta && meta.name) || q.name || q.symbol || '',
      group: (meta && meta.group) || DEFAULT_GROUP,
      price: numOrNull(q.price),
      change: numOrNull(q.change),
      changePct: numOrNull(q.changePct),
      dayLow: numOrNull(q.dayLow),
      dayHigh: numOrNull(q.dayHigh),
      volume: numOrNull(q.volume),
      closes: Array.isArray(q.closes) ? q.closes : []
    };
  }

  function universeMap(universe) {
    var map = {};
    (universe || []).forEach(function (u) {
      if (u && u.symbol) map[u.symbol] = u;
    });
    return map;
  }

  /**
   * Build the rows for one or more groups.
   *
   * `group` may be a single group name, an array of them, or null for
   * everything.
   */
  function buildRows(quotes, universe, group) {
    if (!quotes) return [];
    var meta = universeMap(universe);
    var wanted = null;
    if (Array.isArray(group)) {
      wanted = {};
      group.forEach(function (g) { wanted[g] = true; });
    } else if (group) {
      wanted = {};
      wanted[group] = true;
    }

    return Object.keys(quotes).map(function (symbol) {
      var m = meta[symbol];
      return toRow(quotes[symbol], m);
    }).filter(function (row) {
      if (!wanted) return true;
      return !!wanted[row.group];
    });
  }

  /**
   * Sort rows by one field.
   *
   * Rows whose value is missing sort LAST in both directions — a missing
   * price is not "the smallest", it is unknown, and burying it at the
   * bottom is less misleading than showing it as a loser.
   */
  function sortRows(rows, key, asc) {
    var dir = asc ? 1 : -1;
    return (rows || []).slice().sort(function (a, b) {
      var av = a[key], bv = b[key];
      var aMissing = av === null || av === undefined || av === '';
      var bMissing = bv === null || bv === undefined || bv === '';
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv)) * dir;
      }
      return (av - bv) * dir;
    });
  }

  /**
   * Build the three movers lists.
   *
   * A quote with no percentage change is excluded from gainers and losers
   * — it did not move, so ranking it as a mover would be wrong.
   */
  function buildMovers(quotes, universe, limit) {
    var n = limit || 5;
    var rows = buildRows(quotes, universe, null).filter(function (row) {
      return EXCLUDED_FROM_MOVERS.indexOf(row.group) === -1;
    });

    var moved = rows.filter(function (row) {
      return row.changePct !== null;
    });

    var byPct = moved.slice().sort(function (a, b) {
      return b.changePct - a.changePct;
    });
    var gainers = byPct.slice(0, n);
    var losers = byPct.slice(-n).reverse();

    var byVol = rows.slice().sort(function (a, b) {
      return (b.volume || 0) - (a.volume || 0);
    }).slice(0, n);

    return { gainers: gainers, losers: losers, active: byVol };
  }

  return {
    DEFAULT_GROUP: DEFAULT_GROUP,
    EXCLUDED_FROM_MOVERS: EXCLUDED_FROM_MOVERS,
    toRow: toRow,
    buildRows: buildRows,
    sortRows: sortRows,
    buildMovers: buildMovers
  };
});
