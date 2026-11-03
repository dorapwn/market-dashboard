/*
 * The tracked instrument universe — the single source of truth for which
 * instruments the dashboard follows.
 *
 * It lives in its own module because three separate places need the same
 * list and must never disagree:
 *
 *   - the browser, which fetches quotes for it (assets/app.js)
 *   - the snapshot script, which writes the offline fallback
 *     (scripts/make-snapshot.js)
 *   - CI, which checks the committed snapshot still covers all of it
 *
 * A symbol added here but missing from the snapshot would silently
 * vanish from the page whenever Yahoo is unreachable. The CI check
 * catches that; the tests here catch a malformed entry.
 *
 * No DOM, no fetch, no globals.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Universe = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Every instrument the page tracks.
   *
   * The `group` decides which panel an instrument appears in:
   *   index  -> the Global Indices table
   *   equity -> the Watchlist (and the heatmap, which tracks more)
   *   crypto -> the FX & Crypto table
   *   fx     -> the FX & Crypto table
   */
  var UNIVERSE = [
    // indices
    { symbol: '^GSPC',     name: 'S&P 500',        group: 'index' },
    { symbol: '^IXIC',     name: 'Nasdaq Composite', group: 'index' },
    { symbol: '^DJI',      name: 'Dow Jones',      group: 'index' },
    { symbol: '^RUT',      name: 'Russell 2000',   group: 'index' },
    { symbol: '^VIX',      name: 'CBOE Volatility', group: 'index' },
    { symbol: '^HSI',      name: 'Hang Seng',      group: 'index' },
    { symbol: '^HSCE',     name: 'Hang Seng China', group: 'index' },
    { symbol: '^N225',     name: 'Nikkei 225',     group: 'index' },
    { symbol: '^STOXX50E', name: 'Euro Stoxx 50',  group: 'index' },
    { symbol: '^FTSE',     name: 'FTSE 100',       group: 'index' },
    { symbol: '^TNX',      name: 'US 10-Yr Yield', group: 'index' },
    // equities
    { symbol: 'AAPL', name: 'Apple',            group: 'equity' },
    { symbol: 'MSFT', name: 'Microsoft',        group: 'equity' },
    { symbol: 'NVDA', name: 'NVIDIA',           group: 'equity' },
    { symbol: 'GOOGL', name: 'Alphabet',         group: 'equity' },
    { symbol: 'AMZN', name: 'Amazon',           group: 'equity' },
    { symbol: 'META', name: 'Meta Platforms',   group: 'equity' },
    { symbol: 'TSLA', name: 'Tesla',            group: 'equity' },
    { symbol: 'AVGO', name: 'Broadcom',         group: 'equity' },
    { symbol: 'AMD',  name: 'AMD',              group: 'equity' },
    { symbol: 'NFLX', name: 'Netflix',          group: 'equity' },
    { symbol: 'CRM',  name: 'Salesforce',       group: 'equity' },
    { symbol: 'PLTR', name: 'Palantir',         group: 'equity' },
    { symbol: 'JPM',  name: 'JPMorgan Chase',   group: 'equity' },
    { symbol: 'XOM',  name: 'Exxon Mobil',      group: 'equity' },
    // crypto
    { symbol: 'BTC-USD', name: 'Bitcoin',  group: 'crypto' },
    { symbol: 'ETH-USD', name: 'Ethereum', group: 'crypto' },
    { symbol: 'SOL-USD', name: 'Solana',   group: 'crypto' },
    // fx
    { symbol: 'EURUSD=X', name: 'Euro / US Dollar', group: 'fx' },
    { symbol: 'GBPUSD=X', name: 'Pound / US Dollar', group: 'fx' },
    { symbol: 'JPY=X',    name: 'USD / Japanese Yen', group: 'fx' },
    { symbol: 'HKDCNY=X', name: 'Hong Kong Dollar / Chinese Yuan', group: 'fx' },
    { symbol: 'CNYHKD=X', name: 'Chinese Yuan / Hong Kong Dollar', group: 'fx' },
    { symbol: 'USDHKD=X', name: 'US Dollar / Hong Kong Dollar', group: 'fx' }
  ];

  /**
   * CoinGecko ids for the crypto symbols, used by the keyless fallback
   * fetch. Without an id a crypto row disappears whenever Yahoo fails.
   */
  var COINGECKO_IDS = {
    'BTC-USD': 'bitcoin',
    'ETH-USD': 'ethereum',
    'SOL-USD': 'solana'
  };

  /**
   * The FX pairs the Frankfurter fallback can reconstruct.
   *
   * Frankfurter publishes ECB reference rates, so it can only quote
   * pairs where both currencies are in its set. The Hong Kong dollar and
   * the Chinese yuan both are, and the three Hong Kong pairs are all
   * derivable from USD:
   *
   *   USDHKD = USD -> HKD
   *   USDCNY = USD -> CNY
   *   HKDCNY = USDCNY / USDHKD
   *   CNYHKD = 1 / HKDCNY
   */
  var FX_FALLBACK = {
    'EURUSD=X': { base: 'EUR', quote: 'USD', invert: true },
    'GBPUSD=X': { base: 'GBP', quote: 'USD', invert: true },
    'JPY=X':    { base: 'JPY', quote: 'USD', invert: false },
    'HKDCNY=X': { base: 'HKD', quote: 'CNY', invert: false },
    'CNYHKD=X': { base: 'CNY', quote: 'HKD', invert: false },
    'USDHKD=X': { base: 'USD', quote: 'HKD', invert: false }
  };

  /**
   * The symbols, in order, with no duplicates.
   */
  function symbols() {
    var seen = {};
    var out = [];
    UNIVERSE.forEach(function (u) {
      if (seen[u.symbol]) return;
      seen[u.symbol] = true;
      out.push(u.symbol);
    });
    return out;
  }

  /**
   * The instruments in one group, or all of them when the group is null.
   */
  function ofGroup(group) {
    if (!group) return UNIVERSE.slice();
    return UNIVERSE.filter(function (u) { return u.group === group; });
  }

  return {
    UNIVERSE: UNIVERSE,
    COINGECKO_IDS: COINGECKO_IDS,
    FX_FALLBACK: FX_FALLBACK,
    symbols: symbols,
    ofGroup: ofGroup
  };
});
