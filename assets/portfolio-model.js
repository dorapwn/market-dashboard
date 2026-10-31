/*
 * Portfolio model — pure logic, shared by the browser and the tests.
 *
 * No DOM, no fetch, no globals. Everything here is a pure function over
 * plain data so it can be unit-tested with `npm test` (node --test).
 *
 * The model is also the privacy boundary: `validate()` enforces the key
 * set of a published holding, so a sensitive field (share count, cost
 * basis, balance) fails loudly here instead of reaching the public page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PortfolioModel = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * The only fields a published holding may carry. Anything else is a bug
   * that would leak private portfolio data into a public repository.
   */
  var ALLOWED_KEYS = ['symbol', 'role', 'sector', 'group', 'weight'];

  /**
   * Named separately so the error message says *what* leaked rather than
   * just "unexpected key".
   */
  var SENSITIVE_KEYS = [
    'shares', 'sharecount', 'share_count', 'quantity', 'qty', 'units',
    'amount', 'balance', 'value', 'costbasis', 'cost_basis', 'cost',
    'basis', 'avgprice', 'avg_price', 'entryprice', 'entry_price',
    'broker', 'account', 'tax', 'target', 'rationale'
  ];

  var WEIGHT_SUM_TOLERANCE = 0.01;

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function lowerKeys(holding) {
    return Object.keys(holding).map(function (k) {
      return k.toLowerCase().replace(/[\s-]/g, '');
    });
  }

  /**
   * Check a set of holdings against the publication rules.
   *
   * @returns {{ok: boolean, problems: string[]}}
   */
  function validate(holdings) {
    var problems = [];

    if (!Array.isArray(holdings)) {
      return { ok: false, problems: ['holdings must be an array'] };
    }
    if (holdings.length === 0) {
      return { ok: false, problems: ['no holdings defined'] };
    }

    var seen = {};
    var weightSum = 0;

    holdings.forEach(function (h, i) {
      var where = 'holding ' + i + (h && h.symbol ? ' (' + h.symbol + ')' : '');

      if (!isPlainObject(h)) {
        problems.push(where + ': not an object');
        return;
      }

      // Structural key check — the strong form of the privacy rule.
      var keys = Object.keys(h);
      var lower = lowerKeys(h);
      keys.forEach(function (k, ki) {
        var norm = lower[ki];
        if (ALLOWED_KEYS.indexOf(k) !== -1) return;
        if (SENSITIVE_KEYS.indexOf(norm) !== -1) {
          problems.push(where + ': forbidden field "' + k + '" (private portfolio data)');
        } else {
          problems.push(where + ': unexpected field "' + k + '"');
        }
      });

      if (!h.symbol || typeof h.symbol !== 'string') {
        problems.push(where + ': missing symbol');
      } else if (seen[h.symbol]) {
        problems.push(where + ': duplicate symbol');
      } else {
        seen[h.symbol] = true;
      }

      if (typeof h.weight !== 'number' || !isFinite(h.weight)) {
        problems.push(where + ': weight must be a finite number');
      } else {
        if (h.weight <= 0) {
          problems.push(where + ': weight must be greater than zero');
        }
        if (h.weight > 100) {
          problems.push(where + ': weight must not exceed 100');
        }
        weightSum += h.weight;
      }
    });

    if (Math.abs(weightSum - 100) > WEIGHT_SUM_TOLERANCE) {
      problems.push(
        'allocation weights must sum to 100 (got ' +
        weightSum.toFixed(2) + ')'
      );
    }

    return { ok: problems.length === 0, problems: problems };
  }

  /**
   * Aggregate holdings into the figures the summary strip shows.
   *
   * @param {Array} holdings published holdings
   * @param {Object} quotes symbol -> { changePct }
   */
  function summarize(holdings, quotes) {
    var q = quotes || {};
    var list = holdings || [];

    var tech = 0;
    var nonTech = 0;
    var weightedSum = 0;
    var weightedBase = 0;
    var sectorWeights = {};

    list.forEach(function (h) {
      if (h.group === 'tech') tech += h.weight;
      else nonTech += h.weight;

      sectorWeights[h.sector] = (sectorWeights[h.sector] || 0) + h.weight;

      var quote = q[h.symbol];
      var pct = quote ? quote.changePct : null;
      if (pct !== null && pct !== undefined && !isNaN(pct)) {
        weightedSum += pct * h.weight;
        weightedBase += h.weight;
      }
    });

    var sectorCount = Object.keys(sectorWeights).length;

    return {
      techExposure: round2(tech),
      nonTechExposure: round2(nonTech),
      holdingCount: list.length,
      // Weighted by allocation: a 10% position moving 5% is not a 5% portfolio move.
      weightedMove: weightedBase > 0 ? round2(weightedSum / weightedBase) : null,
      sectorWeights: sectorWeights,
      // A one-sector portfolio has no concentration to show.
      showSectorStrip: sectorCount > 1
    };
  }

  /**
   * Merge the results of chunked quote requests.
   *
   * One chunk failing (timeout, rate limit) must not discard the chunks
   * that succeeded — that is the difference between a partial dashboard and
   * a blank page.
   *
   * @param {Array} chunkResults each entry is an array of quotes, or null on failure
   */
  function mergeQuotes(chunkResults) {
    var quotes = {};
    var failedChunks = 0;
    var succeeded = 0;

    (chunkResults || []).forEach(function (chunk) {
      if (!chunk) {
        failedChunks++;
        return;
      }
      succeeded++;
      chunk.forEach(function (entry) {
        if (entry && entry.symbol) quotes[entry.symbol] = entry;
      });
    });

    return {
      quotes: quotes,
      ok: succeeded > 0 && Object.keys(quotes).length > 0,
      failedChunks: failedChunks
    };
  }

  /**
   * Keep the most recent `n` usable close values.
   * Nulls are dropped (Yahoo emits them for halted sessions).
   */
  function trimCloses(closes, n) {
    if (!closes || !closes.length) return [];
    var pts = closes.filter(function (c) {
      return c !== null && c !== undefined && !isNaN(c);
    });
    if (n && pts.length > n) return pts.slice(pts.length - n);
    return pts;
  }

  /**
   * Build chart data from a snapshot's close series.
   *
   * The snapshot stores closes but not timestamps, so the time axis is
   * reconstructed by walking backwards from the quote's market time in
   * fixed interval steps. Returns null when there is not enough data.
   *
   * @param {Array} closes intraday close values
   * @param {number} endTimestamp UNIX seconds of the last close
   * @param {number} intervalSeconds step between points (default 5 min)
   */
  function snapshotChartData(closes, endTimestamp, intervalSeconds) {
    var pts = trimCloses(closes, 500);
    if (pts.length < 2) return null;
    if (!endTimestamp || !isFinite(endTimestamp)) return null;

    var step = intervalSeconds || 300;
    var xs = [];
    var last = Math.round(endTimestamp);
    for (var i = 0; i < pts.length; i++) {
      xs.push(last - (pts.length - 1 - i) * step);
    }
    return { timestamps: xs, closes: pts, intraday: true };
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  return {
    validate: validate,
    summarize: summarize,
    mergeQuotes: mergeQuotes,
    trimCloses: trimCloses,
    snapshotChartData: snapshotChartData,
    ALLOWED_KEYS: ALLOWED_KEYS,
    SENSITIVE_KEYS: SENSITIVE_KEYS
  };
});
