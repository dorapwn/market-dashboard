/*
 * Market Dashboard — live market data front-end.
 *
 * Data path:
 *   Yahoo Finance chart/spark endpoints -> CORS proxy (r.jina.ai) -> browser.
 *   Yahoo sends no Access-Control-Allow-Origin header, so a browser cannot call
 *   it directly; the proxy is what makes a static GitHub Pages page possible.
 *
 * Fallbacks:
 *   crypto  -> CoinGecko (sends ACAO: *)
 *   FX      -> Frankfurter (ECB reference rates, sends ACAO: *)
 *   stale   -> data/snapshot.json, committed by the refresh workflow.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------- constants

  var PROXY = 'https://r.jina.ai/';
  var YAHOO_SPARK = 'https://query1.finance.yahoo.com/v7/finance/spark';
  var YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';

  var REFRESH_MS = 60000;
  var SPARK_MAX_SYMBOLS = 20;   // Yahoo rejects spark requests with > 20 symbols.
  var FETCH_TIMEOUT_MS = 20000;  // never let a stalled request wedge the UI

  var COINGECKO_IDS = {
    'BTC-USD': 'bitcoin',
    'ETH-USD': 'ethereum',
    'SOL-USD': 'solana'
  };

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
    { symbol: 'JPY=X',    name: 'USD / Japanese Yen', group: 'fx' }
  ];

  /**
   * Portfolio holdings are merged into the fetch universe so their live
   * quotes come from the same request. Only the holding itself is public —
   * no position sizes, share counts or cost basis.
   */
  function portfolioSymbols() {
    return (window.PORTFOLIO && window.PORTFOLIO.holdings || []).map(function (h) {
      return h.symbol;
    });
  }

  function portfolioHoldings() {
    var p = window.PORTFOLIO;
    if (!p || !p.holdings) return [];
    return p.holdings.map(function (h) {
      var q = state.quotes[h.symbol] || {};
      return {
        symbol: h.symbol,
        role: h.role,
        sector: h.sector,
        group: h.group,
        weight: h.weight,
        price: q.price,
        changePct: q.changePct,
        dayHigh: q.dayHigh,
        dayLow: q.dayLow,
        closes: q.closes
      };
    });
  }

  function allSymbols() {
    var seen = {};
    var out = [];
    UNIVERSE.concat(
      (window.PORTFOLIO && window.PORTFOLIO.holdings || []).map(function (h) {
        return { symbol: h.symbol, name: h.symbol, group: 'portfolio' };
      })
    ).forEach(function (u) {
      if (seen[u.symbol]) return;
      seen[u.symbol] = true;
      out.push(u.symbol);
    });
    return out;
  }

  var RANGES = {
    '1d':  { range: '1d',  interval: '5m',  label: 'Intraday · 5m' },
    '5d':  { range: '5d',  interval: '15m', label: '5 days · 15m' },
    '1mo': { range: '1mo', interval: '1d',  label: '1 month · daily' },
    '6mo': { range: '6mo', interval: '1d',  label: '6 months · daily' },
    '1y':  { range: '1y',  interval: '1d',  label: '1 year · daily' },
    '5y':  { range: '5y',  interval: '1wk', label: '5 years · weekly' }
  };

  // ----------------------------------------------------------------- state

  var state = {
    quotes: {},            // symbol -> quote record
    selected: '^GSPC',
    range: '1d',
    sortKey: 'changePct',
    sortAsc: false,
    tableSort: null,      // per-table sort state, set up in bindEvents()
    auto: true,
    timer: null,
    lastUpdate: null,
    source: 'live',
    chart: null,           // uPlot instance
    chartData: null,
    stale: false
  };

  var els = {};

  function $(id) { return document.getElementById(id); }

  // --------------------------------------------------------------- helpers

  function fmtNum(v, digits) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toLocaleString('en-US', {
      minimumFractionDigits: digits === undefined ? 2 : digits,
      maximumFractionDigits: digits === undefined ? 2 : digits
    });
  }

  function fmtPrice(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var a = Math.abs(v);
    if (a >= 1000) return fmtNum(v, 2);
    if (a >= 1) return fmtNum(v, 2);
    if (a >= 0.01) return fmtNum(v, 4);
    return fmtNum(v, 6);
  }

  function fmtCompact(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var a = Math.abs(v);
    if (a >= 1e12) return (v / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(2) + 'K';
    return fmtNum(v, 2);
  }

  function fmtPct(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  }

  function fmtSigned(v, digits) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (v >= 0 ? '+' : '') + fmtNum(v, digits === undefined ? 2 : digits);
  }

  function dirClass(v) {
    if (v === null || v === undefined || isNaN(v) || v === 0) return 'flat';
    return v > 0 ? 'up' : 'down';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ------------------------------------------------------------ data layer

  /**
   * Fetch a Yahoo endpoint through the CORS proxy.
   * Uses x-respond-with: text so the body is raw JSON rather than
   * jina's markdown-wrapped default.
   *
   * `path` must carry the symbol as a path segment (e.g. /chart/AAPL) —
   * Yahoo's chart endpoint does not accept ?symbol=.
   */
  function fetchYahoo(path, query) {
    var url = PROXY + path + '?' + query + '&_cb=' + Date.now();
    var opts = {
      headers: { 'x-respond-with': 'text' },
      cache: 'no-store',
      signal: timeoutSignal(FETCH_TIMEOUT_MS)
    };
    return fetch(url, opts).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (text) {
      // Defensive: the proxy may still wrap the payload in a markdown envelope.
      var start = text.indexOf('{');
      if (start === -1) throw new Error('malformed response');
      return JSON.parse(text.slice(start));
    });
  }

  /** AbortSignal that fires after ms, so a hung fetch cannot wedge the UI. */
  function timeoutSignal(ms) {
    if (typeof AbortController === 'undefined') return undefined;
    var controller = new AbortController();
    setTimeout(function () { controller.abort(); }, ms);
    return controller.signal;
  }

  function chunk(arr, size) {
    var out = [];
    for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  /** Normalise one Yahoo spark result into a quote record. */
  function quoteFromSpark(symbol, meta, series) {
    var price = meta.regularMarketPrice;
    var prev = meta.chartPreviousClose !== undefined && meta.chartPreviousClose !== null
      ? meta.chartPreviousClose
      : meta.previousClose;
    var change = (price !== null && price !== undefined && prev !== null && prev !== undefined)
      ? price - prev : null;
    var changePct = (change !== null && prev) ? (change / prev) * 100 : null;

    var closes = (series && series.close) || [];

    return {
      symbol: symbol,
      name: meta.shortName || meta.longName || symbol,
      price: price,
      prevClose: prev,
      change: change,
      changePct: changePct,
      dayHigh: meta.regularMarketDayHigh,
      dayLow: meta.regularMarketDayLow,
      high52: meta.fiftyTwoWeekHigh,
      low52: meta.fiftyTwoWeekLow,
      volume: meta.regularMarketVolume,
      currency: meta.currency,
      timezone: meta.exchangeTimezoneName,
      gmtoffset: meta.gmtoffset,
      marketTime: meta.regularMarketTime,
      closes: closes,
      series: series
    };
  }

  /**
   * Pull live quotes for the whole universe, respecting Yahoo's 20-symbol cap.
   *
   * Chunks are settled independently: one chunk timing out or being
   * rate-limited must not discard the chunks that succeeded. Only when
   * every chunk fails does this fall back to the committed snapshot.
   */
  function fetchQuotes() {
    var symbols = allSymbols();
    var groups = chunk(symbols, SPARK_MAX_SYMBOLS);

    return Promise.all(groups.map(function (group) {
      var q = 'symbols=' + encodeURIComponent(group.join(',')) + '&range=1d&interval=5m';
      return fetchYahoo(YAHOO_SPARK, q)
        .then(function (payload) {
          var results = (payload.spark && payload.spark.result) || [];
          return results.map(function (entry) {
            var resp = entry.response && entry.response[0];
            if (!resp || !resp.meta) return null;
            return quoteFromSpark(entry.symbol, resp.meta, resp.indicators && resp.indicators.quote && resp.indicators.quote[0]);
          }).filter(Boolean);
        })
        .catch(function () {
          // This chunk failed; the others may still succeed.
          return null;
        });
    })).then(function (chunkResults) {
      var merged = window.PortfolioModel.mergeQuotes(chunkResults);
      if (!merged.ok) throw new Error('no quotes returned');
      if (merged.failedChunks) {
        console.warn('[market-dashboard] ' + merged.failedChunks + ' quote chunk(s) failed; showing partial data.');
      }
      return merged.quotes;
    });
  }

  /** CoinGecko spot prices for the crypto cards (CORS-enabled, no key). */
  function fetchCryptoFallback() {
    var ids = Object.keys(COINGECKO_IDS).map(function (s) { return COINGECKO_IDS[s]; }).join(',');
    var url = 'https://api.coingecko.com/api/v3/simple/price?ids=' + ids +
      '&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true';
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        var out = {};
        Object.keys(COINGECKO_IDS).forEach(function (sym) {
          var d = data[COINGECKO_IDS[sym]];
          if (!d || d.usd === undefined) return;
          out[sym] = {
            symbol: sym,
            name: sym.replace('-USD', ''),
            price: d.usd,
            changePct: d.usd_24h_change,
            volume: d.usd_24h_vol,
            currency: 'USD',
            source: 'coingecko'
          };
        });
        return out;
      });
  }

  /** Frankfurter / ECB reference rates for FX cards (CORS-enabled, no key). */
  function fetchFxFallback() {
    var url = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,JPY';
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        var rates = data.rates || {};
        var out = {};
        if (rates.EUR) out['EURUSD=X'] = { symbol: 'EURUSD=X', name: 'Euro / US Dollar', price: 1 / rates.EUR, changePct: null, currency: 'USD', source: 'frankfurter' };
        if (rates.GBP) out['GBPUSD=X'] = { symbol: 'GBPUSD=X', name: 'Pound / US Dollar', price: 1 / rates.GBP, changePct: null, currency: 'USD', source: 'frankfurter' };
        if (rates.JPY) out['JPY=X']    = { symbol: 'JPY=X',    name: 'USD / Japanese Yen', price: rates.JPY, changePct: null, currency: 'JPY', source: 'frankfurter' };
        return out;
      });
  }

  /** Last committed snapshot — used when every live source fails. */
  function fetchSnapshot() {
    return fetch('data/snapshot.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('no snapshot'); return r.json(); })
      .then(function (snap) {
        if (!snap || !snap.quotes) throw new Error('snapshot empty');
        return snap;
      });
  }

  // --------------------------------------------------------------- heatmap

  /**
   * The heatmap dataset: every S&P 500 constituent with its GICS sector and
   * sub-industry, market cap and last change.
   *
   * It is a separate file from the quote snapshot because it is much larger
   * and changes far less often (the index membership moves quarterly, the
   * prices every minute).
   */
  var heatmapData = null;
  var heatmapLayout = null;

  function fetchHeatmap() {
    return fetch('data/heatmap.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('no heatmap'); return r.json(); })
      .then(function (d) {
        if (!d || !d.items || !d.items.length) throw new Error('heatmap empty');
        return d;
      });
  }

  /**
   * Merge the live quotes over the heatmap's own snapshot values.
   *
   * The heatmap covers 500+ symbols, but the page's live feed only carries
   * the tracked universe, so most tiles keep the value from the dataset and
   * the tracked ones get the fresher live number.
   */
  function heatmapItems() {
    if (!heatmapData) return [];
    return heatmapData.items.map(function (it) {
      var q = state.quotes[it.symbol];
      if (!q) return it;
      return {
        symbol: it.symbol,
        name: it.name,
        sector: it.sector,
        industry: it.industry,
        marketCap: it.marketCap,
        price: q.price !== undefined && q.price !== null ? q.price : it.price,
        changePct: q.changePct !== undefined && q.changePct !== null ? q.changePct : it.changePct
      };
    });
  }

  function renderHeatmap() {
    var canvas = els.heatmapCanvas;
    if (!canvas || !heatmapData) return;

    // clientWidth/Height are the layout box, excluding any border or
    // scrollbar. getBoundingClientRect() can still report the OLD size
    // while the browser is applying a new viewport, which lays the treemap
    // out for the wrong width and pushes tiles off the edge.
    var w = Math.max(320, canvas.clientWidth || 0);
    var h = Math.max(280, canvas.clientHeight || 0);
    if (!w || !h) return;

    var items = heatmapItems();
    if (!items.length) return;

    var layout = window.HeatmapModel.layout(items, w, h);
    heatmapLayout = layout;

    var html = [];

    // The two halves (tech / non-tech) get a label and a divider.
    ['tech', 'nontech'].forEach(function (key) {
      var g = layout[key];
      if (!g || !g.sectors.length) return;
      html.push('<div class="hm-group-label" style="left:' + g.x.toFixed(1) + 'px">' +
        (key === 'tech' ? 'Tech' : 'Non-tech') + ' · ' + g.sectors.length + ' sectors</div>');
      html.push('<div class="hm-group-rule" style="left:' + (g.x + g.w).toFixed(1) + 'px;top:0;height:' +
        h + 'px"></div>');
    });

    // Sector tiles, then the industry tiles inside them, then the stocks.
    layout.sectors.forEach(function (sector) {
      html.push('<div class="hm-sector" style="left:' + sector.x.toFixed(1) + 'px;top:' + sector.y.toFixed(1) +
        'px;width:' + sector.w.toFixed(1) + 'px;height:' + sector.h.toFixed(1) + 'px">');
      html.push('<span class="hm-sector-label">' + escapeHtml(sector.sector) + '</span>');

      sector.industries.forEach(function (ind) {
        html.push('<div class="hm-industry" style="left:' + (ind.x - sector.x).toFixed(1) + 'px;top:' +
          (ind.y - sector.y).toFixed(1) + 'px;width:' + ind.w.toFixed(1) + 'px;height:' + ind.h.toFixed(1) + 'px">');
        // The industry label is only worth drawing if the cell can hold it.
        // The model already reserved a band for it, so the label and the
        // largest stock tile never overlap.
        if (ind.w > 52 && ind.h > 30) {
          html.push('<span class="hm-industry-label">' + escapeHtml(ind.industry) + '</span>');
        }

        ind.stocks.forEach(function (t) {
          var cls = 'hm-tile' + (t.showLabel ? ' has-label' : '') +
            (state.selected === t.symbol ? ' is-selected' : '');
          // Big tiles get bigger type, otherwise a mega-cap like AAPL is a
          // large expanse of colour with 10px text in the corner.
          if (t.area >= 20000) cls += ' is-lg';
          else if (t.area >= 6000) cls += ' is-md';
          var bg = window.HeatmapModel.heatColor(t.changePct);
          var style = 'left:' + (t.x - ind.x).toFixed(1) + 'px;top:' + (t.y - ind.y).toFixed(1) +
            'px;width:' + t.w.toFixed(1) + 'px;height:' + t.h.toFixed(1) + 'px;background:' + bg;
          var label = '';
          if (t.showLabel) {
            label = '<span class="hm-sym">' + escapeHtml(t.symbol) + '</span>' +
              '<span class="hm-chg">' + fmtPct(t.changePct) + '</span>';
          }
          html.push('<button type="button" class="' + cls + '" style="' + style + '" ' +
            'data-symbol="' + escapeHtml(t.symbol) + '" ' +
            'data-sector="' + escapeHtml(t.sector) + '" ' +
            'data-industry="' + escapeHtml(t.industry) + '" ' +
            'data-name="' + escapeHtml(t.name || '') + '" ' +
            'data-price="' + (t.price === null || t.price === undefined ? '' : t.price) + '" ' +
            'data-change="' + (t.changePct === null || t.changePct === undefined ? '' : t.changePct) + '" ' +
            'data-cap="' + (t.marketCap || 0) + '" ' +
            'aria-label="' + escapeHtml(t.symbol + ' ' + (t.name || '') + ' ' + fmtPct(t.changePct)) + '">' +
            label + '</button>');
        });

        html.push('</div>');
      });

      html.push('</div>');
    });

    canvas.innerHTML = html.join('');
    els.heatmapLoading.hidden = true;

    var stats = layout.stats;
    els.heatmapNote.textContent = stats.techCount + ' tech + ' + stats.nonTechCount + ' non-tech · ' +
      stats.industries + ' industries · S&P 500 by market cap';
  }

  /**
   * The tooltip follows the pointer and shows the full detail for a tile.
   */
  function showHeatmapTip(tile, evt) {
    var tip = els.heatmapTip;
    var wrap = els.heatmapCanvas.parentElement;
    if (!tile || !tip || !wrap) return;

    var symbol = tile.getAttribute('data-symbol');
    var price = tile.getAttribute('data-price');
    var cap = parseFloat(tile.getAttribute('data-cap')) || 0;
    var changePct = tile.getAttribute('data-change');
    var q = state.quotes[symbol];
    if (q && q.changePct !== undefined && q.changePct !== null) changePct = q.changePct;

    tip.innerHTML =
      '<div class="hm-tip-sym">' + escapeHtml(symbol) + '</div>' +
      '<div class="hm-tip-name">' + escapeHtml(tile.getAttribute('data-name') || '') + '</div>' +
      '<div class="hm-tip-row"><span>Last</span><span>' + (price ? fmtPrice(parseFloat(price)) : '—') + '</span></div>' +
      '<div class="hm-tip-row"><span>Change</span><span class="' + dirClass(parseFloat(changePct)) + '">' +
        fmtPct(parseFloat(changePct)) + '</span></div>' +
      '<div class="hm-tip-row"><span>Market cap</span><span>' + fmtCompact(cap) + '</span></div>' +
      '<div class="hm-tip-path">' + escapeHtml(tile.getAttribute('data-sector') || '') +
        ' › ' + escapeHtml(tile.getAttribute('data-industry') || '') + '</div>';

    tip.hidden = false;

    // Keep the tooltip inside the panel.
    var wrapRect = wrap.getBoundingClientRect();
    var tipRect = tip.getBoundingClientRect();
    var x = evt.clientX - wrapRect.left + 14;
    var y = evt.clientY - wrapRect.top + 14;
    if (x + tipRect.width > wrapRect.width) x = evt.clientX - wrapRect.left - tipRect.width - 14;
    if (y + tipRect.height > wrapRect.height) y = evt.clientY - wrapRect.top - tipRect.height - 14;
    tip.style.left = Math.max(4, x) + 'px';
    tip.style.top = Math.max(4, y) + 'px';
  }

  function hideHeatmapTip() {
    if (els.heatmapTip) els.heatmapTip.hidden = true;
  }

  function initHeatmap() {
    fetchHeatmap().then(function (d) {
      heatmapData = d;
      renderHeatmap();
    }).catch(function (err) {
      // The heatmap is an addition, not the page's core: if it cannot load,
      // the rest of the dashboard must still work.
      console.warn('[market-dashboard] heatmap unavailable:', err.message);
      els.heatmapLoading.textContent = 'Heatmap unavailable';
      els.heatmapNote.textContent = 'S&P 500 heatmap unavailable';
    });
  }

  // ------------------------------------------------------------- portfolio

  function renderSectorStrip(holdings, summary) {
    var p = window.PORTFOLIO;
    if (!p) return;

    // A single-sector portfolio has no concentration to show, and a one-cell
    // strip would just be a coloured bar with nothing to compare against.
    if (!summary.showSectorStrip) {
      els.sectorStrip.innerHTML = '';
      els.sectorStrip.hidden = true;
      return;
    }
    els.sectorStrip.hidden = false;

    var bySector = summary.sectorWeights;
    var order = p.sectorOrder || Object.keys(bySector);
    // The strip only renders when the holdings carry weights, so the
    // denominator is the published total.
    var total = summary.techExposure + summary.nonTechExposure;
    if (!total || !isFinite(total)) total = 1;

    var segs = order.filter(function (s) { return bySector[s]; }).map(function (s) {
      var pct = (bySector[s] / total) * 100;
      return '<div class="sector-seg sector-' + escapeHtml(s.toLowerCase().replace(/[^a-z]/g, '')) + '" ' +
        'style="flex-grow:' + bySector[s].toFixed(2) + '" ' +
        'title="' + escapeHtml(s) + ' — ' + pct.toFixed(2) + '%">' +
        '<span class="sector-seg-label">' + escapeHtml(s) + '</span>' +
        '<span class="sector-seg-pct">' + pct.toFixed(1) + '%</span>' +
        '</div>';
    }).join('');

    els.sectorStrip.innerHTML = segs;
  }

  function renderPortfolio() {
    if (!window.PORTFOLIO) return;
    var holdings = portfolioHoldings();

    // All portfolio figures come from the tested model, so the browser and
    // the unit tests agree on exactly one implementation.
    var summary = window.PortfolioModel.summarize(holdings, state.quotes);

    // The allocation percentage is only published when it is known. When it
    // is not, the figures read "—" rather than showing a fabricated share.
    els.techExposure.textContent = summary.techExposure === null
      ? '—' : summary.techExposure.toFixed(2) + '%';
    els.nonTechExposure.textContent = summary.nonTechExposure === null
      ? '—' : summary.nonTechExposure.toFixed(2) + '%';
    els.holdingCount.textContent = String(summary.holdingCount);

    if (summary.weightedMove !== null) {
      els.weightedMove.textContent = fmtPct(summary.weightedMove);
      els.weightedMove.className = 'alloc-figure-value ' + dirClass(summary.weightedMove);
    } else {
      els.weightedMove.textContent = '—';
      els.weightedMove.className = 'alloc-figure-value';
    }

    renderSectorStrip(holdings, summary);

    // Table, sorted by this table's own sort key when it applies.
    var rows = holdings.slice();
    var st = (state.tableSort && state.tableSort.portfolio) || { key: 'changePct', asc: false };
    var key = st.key;
    if (key === 'symbol' || key === 'role' || key === 'price' || key === 'changePct') {
      var dir = st.asc ? 1 : -1;
      if (key === 'symbol' || key === 'role') {
        rows.sort(function (a, b) { return String(a[key]).localeCompare(String(b[key])) * dir; });
      } else {
        rows.sort(function (a, b) {
          var av = a[key], bv = b[key];
          if (av === null || av === undefined) return 1;
          if (bv === null || bv === undefined) return -1;
          return (av - bv) * dir;
        });
      }
    }

    els.portfolioBody.innerHTML = rows.map(function (h) {
      var cls = dirClass(h.changePct);
      var rangeHtml = '';
      if (h.dayLow !== null && h.dayLow !== undefined && h.dayHigh !== null && h.dayHigh !== undefined && h.dayHigh !== h.dayLow) {
        var span = h.dayHigh - h.dayLow;
        var pos = Math.max(0, Math.min(100, ((h.price - h.dayLow) / span) * 100));
        var fillCls = h.price >= (h.dayLow + h.dayHigh) / 2 ? 'up' : 'down';
        rangeHtml = '<div class="range-wrap"><span class="range-txt">' + fmtPrice(h.dayLow) + '</span>' +
          '<span class="range-bar"><i class="' + fillCls + '" style="left:0;width:' + pos.toFixed(1) + '%"></i></span>' +
          '<span class="range-txt">' + fmtPrice(h.dayHigh) + '</span></div>';
      } else {
        rangeHtml = '<span class="range-txt">—</span>';
      }

      return '<tr data-symbol="' + escapeHtml(h.symbol) + '"' +
        (state.selected === h.symbol ? ' class="is-selected"' : '') + '>' +
        '<td class="sym-cell">' + escapeHtml(h.symbol) + '</td>' +
        '<td class="name-cell">' + escapeHtml(h.role) + '</td>' +
        '<td class="col-num num">' + fmtPrice(h.price) + '</td>' +
        '<td class="col-num num ' + cls + '">' + fmtPct(h.changePct) + '</td>' +
        '<td class="col-range">' + rangeHtml + '</td>' +
        '<td class="col-spark">' + sparkline(h.closes, 72, 22) + '</td>' +
        '</tr>';
    }).join('');
  }

  // ------------------------------------------------------------- rendering

  function renderIndices() {
    var grid = els.indexGrid;
    var idx = UNIVERSE.filter(function (u) { return u.group === 'index'; });
    var html = idx.map(function (u) {
      var q = state.quotes[u.symbol];
      if (!q) return '';
      var cls = dirClass(q.changePct);
      return '<button class="index-card' + (state.selected === u.symbol ? ' is-selected' : '') +
        '" type="button" data-symbol="' + escapeHtml(u.symbol) + '">' +
        '<div class="index-sym">' + escapeHtml(u.symbol) + '</div>' +
        '<div class="index-name">' + escapeHtml(u.name) + '</div>' +
        '<div class="index-px">' + fmtPrice(q.price) + '</div>' +
        '<div class="index-chg ' + cls + '">' + fmtSigned(q.change, 2) + ' (' + fmtPct(q.changePct) + ')</div>' +
        '</button>';
    }).join('');
    grid.innerHTML = html;
  }

  function renderTicker() {
    var syms = Object.keys(state.quotes);
    if (!syms.length) { els.tickerTrack.innerHTML = ''; return; }
    var items = syms.map(function (s) {
      var q = state.quotes[s];
      var cls = dirClass(q.changePct);
      return '<span class="ticker-item">' +
        '<span class="ticker-sym">' + escapeHtml(s) + '</span>' +
        '<span class="ticker-px">' + fmtPrice(q.price) + '</span>' +
        '<span class="ticker-chg ' + cls + '">' + fmtPct(q.changePct) + '</span>' +
        '</span>';
    }).join('');
    // duplicated once so the marquee loop is seamless
    els.tickerTrack.innerHTML = items + items;
  }

  function sparkline(closes, width, height) {
    if (!closes || closes.length < 2) return '';
    var pts = closes.filter(function (c) { return c !== null && c !== undefined; });
    if (pts.length < 2) return '';
    var min = Math.min.apply(null, pts);
    var max = Math.max.apply(null, pts);
    var span = (max - min) || 1;
    var step = width / (pts.length - 1);
    var d = pts.map(function (v, i) {
      var x = (i * step).toFixed(2);
      var y = (height - ((v - min) / span) * (height - 2) - 1).toFixed(2);
      return (i === 0 ? 'M' : 'L') + x + ',' + y;
    }).join(' ');
    var rising = pts[pts.length - 1] >= pts[0];
    var color = rising ? '#3fb950' : '#f85149';
    return '<svg class="spark" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height +
      '" aria-hidden="true"><path d="' + d + '" stroke="' + color + '"/></svg>';
  }

  function sortQuotes(list) {
    var st = (state.tableSort && state.tableSort.watchlist) || { key: 'changePct', asc: false };
    var key = st.key;
    var dir = st.asc ? 1 : -1;
    return list.slice().sort(function (a, b) {
      var av = a[key], bv = b[key];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
  }

  /**
   * Symbols that belong only to the portfolio (not the general market
   * watchlist). They are shown in the portfolio table instead, so they are
   * excluded from the watchlist table to avoid showing the same holding twice.
   */
  function portfolioOnlySymbols() {
    var inUniverse = {};
    UNIVERSE.forEach(function (u) { inUniverse[u.symbol] = true; });
    var out = {};
    portfolioSymbols().forEach(function (s) {
      if (!inUniverse[s]) out[s] = true;
    });
    return out;
  }

  function renderWatchlist() {
    var body = els.watchlistBody;
    var portfolioOnly = portfolioOnlySymbols();
    var list = Object.keys(state.quotes).map(function (s) {
      var q = state.quotes[s];
      var meta = UNIVERSE.filter(function (u) { return u.symbol === s; })[0];
      q.group = meta ? meta.group : 'equity';
      q.displayName = meta ? meta.name : q.name;
      return q;
    }).filter(function (q) { return !portfolioOnly[q.symbol]; });
    list = sortQuotes(list);

    var html = list.map(function (q) {
      var cls = dirClass(q.changePct);
      var rangeHtml = '';
      if (q.dayLow !== null && q.dayLow !== undefined && q.dayHigh !== null && q.dayHigh !== undefined && q.dayHigh !== q.dayLow) {
        var span = q.dayHigh - q.dayLow;
        var pos = Math.max(0, Math.min(100, ((q.price - q.dayLow) / span) * 100));
        var fillCls = q.price >= (q.dayLow + q.dayHigh) / 2 ? 'up' : 'down';
        rangeHtml = '<div class="range-wrap"><span class="range-txt">' + fmtPrice(q.dayLow) + '</span>' +
          '<span class="range-bar"><i class="' + fillCls + '" style="left:0;width:' + pos.toFixed(1) + '%"></i></span>' +
          '<span class="range-txt">' + fmtPrice(q.dayHigh) + '</span></div>';
      } else {
        rangeHtml = '<span class="range-txt">—</span>';
      }

      return '<tr data-symbol="' + escapeHtml(q.symbol) + '"' +
        (state.selected === q.symbol ? ' class="is-selected"' : '') + '>' +
        '<td class="sym-cell">' + escapeHtml(q.symbol) + '</td>' +
        '<td class="name-cell">' + escapeHtml(q.displayName) + '</td>' +
        '<td class="col-num num">' + fmtPrice(q.price) + '</td>' +
        '<td class="col-num num ' + cls + '">' + fmtSigned(q.change, 2) + '</td>' +
        '<td class="col-num num ' + cls + '">' + fmtPct(q.changePct) + '</td>' +
        '<td class="col-range">' + rangeHtml + '</td>' +
        '<td class="col-num num">' + fmtCompact(q.volume) + '</td>' +
        '<td class="col-spark">' + sparkline(q.closes, 72, 22) + '</td>' +
        '</tr>';
    }).join('');
    body.innerHTML = html;
  }

  function renderMovers() {
    var list = Object.keys(state.quotes).map(function (s) {
      var q = state.quotes[s];
      // Group matters here: FX pairs are excluded from the movers lists.
      // Assign it locally rather than relying on renderWatchlist() having
      // run first.
      var meta = UNIVERSE.filter(function (u) { return u.symbol === s; })[0];
      q.group = meta ? meta.group : 'equity';
      return q;
    }).filter(function (q) { return q.group !== 'fx'; });

    var byPct = list.slice().sort(function (a, b) {
      return (b.changePct || 0) - (a.changePct || 0);
    });
    var gainers = byPct.slice(0, 5);
    var losers = byPct.slice(-5).reverse();

    var byVol = list.slice().sort(function (a, b) {
      return (b.volume || 0) - (a.volume || 0);
    }).slice(0, 5);

    function li(q, valueText, valueClass) {
      return '<li data-symbol="' + escapeHtml(q.symbol) + '">' +
        '<span class="mover-sym">' + escapeHtml(q.symbol) + '</span>' +
        '<span class="mover-val ' + (valueClass || '') + '">' + valueText + '</span></li>';
    }

    els.gainersList.innerHTML = gainers.map(function (q) {
      return li(q, fmtPct(q.changePct), dirClass(q.changePct));
    }).join('');

    els.losersList.innerHTML = losers.map(function (q) {
      return li(q, fmtPct(q.changePct), dirClass(q.changePct));
    }).join('');

    els.activeList.innerHTML = byVol.map(function (q) {
      return li(q, fmtCompact(q.volume), '');
    }).join('');
  }

  function renderAux() {
    var crypto = UNIVERSE.filter(function (u) { return u.group === 'crypto'; });
    var fx = UNIVERSE.filter(function (u) { return u.group === 'fx'; });
    var all = crypto.concat(fx);

    els.auxGrid.innerHTML = all.map(function (u) {
      var q = state.quotes[u.symbol];
      if (!q) return '';
      var cls = dirClass(q.changePct);
      var chg = q.changePct === null || q.changePct === undefined ? '—' : fmtPct(q.changePct);
      return '<button class="aux-card" type="button" data-symbol="' + escapeHtml(u.symbol) + '">' +
        '<div class="aux-sym">' + escapeHtml(u.symbol) + '</div>' +
        '<div class="aux-name">' + escapeHtml(u.name) + '</div>' +
        '<div class="aux-px">' + fmtPrice(q.price) + '</div>' +
        '<div class="aux-chg ' + cls + '">' + chg + '</div>' +
        '</button>';
    }).join('');
  }

  /**
   * Wall-clock time in US Eastern, independent of the instrument's own exchange.
   * The primary session shown in the header is the US one.
   */
  function easternParts(now) {
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    var parts = {};
    fmt.formatToParts(now).forEach(function (p) { parts[p.type] = p.value; });
    var dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      day: dayMap[parts.weekday],
      minutes: parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10)
    };
  }

  function renderStatus() {
    var dot = els.statusDot;
    var label = els.statusLabel;
    dot.className = 'status-dot';

    if (state.stale) {
      dot.classList.add('is-error');
      label.textContent = 'Stale snapshot';
      return;
    }

    var et = easternParts(new Date());
    var isWeekend = (et.day === 0 || et.day === 6);
    var open = 9 * 60 + 30;
    var close = 16 * 60;

    if (isWeekend) {
      dot.classList.add('is-closed');
      label.textContent = 'US markets closed · weekend';
    } else if (et.minutes >= open && et.minutes < close) {
      dot.classList.add('is-open');
      label.textContent = 'US market open';
    } else if (et.minutes >= 4 * 60 && et.minutes < open) {
      dot.classList.add('is-pre');
      label.textContent = 'US pre-market';
    } else if (et.minutes >= close && et.minutes < 20 * 60) {
      dot.classList.add('is-post');
      label.textContent = 'US after hours';
    } else {
      dot.classList.add('is-closed');
      label.textContent = 'US market closed';
    }
  }

  function renderAll() {
    renderIndices();
    renderTicker();
    renderPortfolio();
    renderWatchlist();
    renderMovers();
    renderAux();
    renderStatus();
    // The heatmap carries its own snapshot values for the long tail of the
    // index, so it is re-rendered to pick up the live numbers for the
    // symbols this page actually tracks.
    if (heatmapData) renderHeatmap();
    els.lastUpdate.textContent = state.lastUpdate
      ? state.lastUpdate.toLocaleTimeString('en-US', { hour12: false })
      : '—';
    els.indicesNote.textContent = state.stale
      ? 'Snapshot from ' + (state.lastUpdate ? state.lastUpdate.toLocaleString('en-US') : 'last commit')
      : 'Live · ' + Object.keys(state.quotes).length + ' instruments';
    els.auxNote.textContent = state.source === 'live' ? 'Live' : 'Fallback feed';
  }

  // ---------------------------------------------------------------- chart

  function chartIntervalFor(rangeKey) {
    var r = RANGES[rangeKey];
    return r;
  }

  function buildChartOptions(data, meta) {
    var isIntraday = data.intraday;
    var rising = data.closes.length ? data.closes[data.closes.length - 1] >= data.closes[0] : true;
    var color = rising ? '#3fb950' : '#f85149';
    var fill = rising ? 'rgba(63,185,80,0.12)' : 'rgba(248,81,73,0.12)';

    // uPlot.fmtDate is a FACTORY: it takes a template string and returns a
    // formatter function. Calling it with a Date would produce garbage labels.
    var fmtIntraday = uPlot.fmtDate('{h}:{mm}');
    var fmtDaily = uPlot.fmtDate('{MM}-{DD}');

    return {
      width: els.chartHost.clientWidth || 640,
      height: els.chartHost.clientHeight || 300,
      cursor: {
        drag: { x: false, y: false },
        points: { size: 7 }
      },
      legend: { show: false },
      scales: { x: { time: true } },
      axes: [
        {
          stroke: '#62666d',
          grid: { stroke: 'rgba(255,255,255,0.05)', width: 1 },
          ticks: { stroke: 'rgba(255,255,255,0.05)', width: 1, size: 5 },
          // uPlot hands us raw UNIX seconds on a time axis; convert to Date
          // before formatting.
          values: function (u, vals) {
            return vals.map(function (v) {
              var d = new Date(v * 1000);
              return isIntraday ? fmtIntraday(d) : fmtDaily(d);
            });
          },
          // Thin out the ticks: at 13 splits the labels collide into an
          // unreadable smear on a ~980px chart.
          splits: function (u, axisIdx, min, max, foundIncr, foundSpace) {
            var want = Math.max(2, Math.min(foundSpace, 7));
            var incr = (max - min) / want;
            var out = [];
            for (var v = min; v <= max; v += incr) out.push(v);
            return out;
          }
        },
        {
          stroke: '#62666d',
          grid: { stroke: 'rgba(255,255,255,0.05)', width: 1 },
          ticks: { stroke: 'rgba(255,255,255,0.05)', width: 1, size: 5 },
          // Reserve room for long values (e.g. "10,669.10") so they are not
          // clipped by the axis gutter.
          size: 64,
          values: function (u, vals) {
            return vals.map(function (v) { return fmtPrice(v); });
          }
        }
      ],
      series: [
        {},
        {
          stroke: color,
          fill: fill,
          width: 1.6,
          points: { show: false }
        }
      ]
    };
  }

  function trimCloses(closes, n) {
    return window.PortfolioModel.trimCloses(closes, n);
  }

  function renderChart() {
    var data = state.chartData;
    if (!data || !data.timestamps || !data.timestamps.length) {
      els.chartLoading.hidden = false;
      els.chartLoading.textContent = 'No chart data available';
      els.chartLoading.classList.add('chart-error');
      return;
    }
    els.chartLoading.hidden = true;
    els.chartLoading.classList.remove('chart-error');

    var meta = state.quotes[state.selected] || {};
    var opts = buildChartOptions(data, meta);
    opts.series[1].label = state.selected;

    if (state.chart) {
      state.chart.setData(data.series);
      state.chart.setSize({ width: opts.width, height: opts.height });
    } else {
      state.chart = new uPlot(opts, data.series, els.chartHost);
    }

    // Expose the chart instance for automated verification.
    window.__marketChart = state.chart;
  }

  function loadChart(symbol, rangeKey) {
    var r = chartIntervalFor(rangeKey);
    var q = 'range=' + r.range + '&interval=' + r.interval;
    els.chartLoading.hidden = false;
    els.chartLoading.textContent = 'Loading chart…';

    return fetchYahoo(YAHOO_CHART + '/' + encodeURIComponent(symbol), q)
      .then(function (payload) {
        var result = payload.chart && payload.chart.result && payload.chart.result[0];
        if (!result) throw new Error('no chart result');
        var stamps = result.timestamp || [];
        var quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
        var closes = quote.close || [];

        // uPlot's AlignedData format is [xValues[], yValues[]] — two parallel
        // arrays, NOT an array of {x, y} objects. A time axis expects UNIX
        // timestamps in SECONDS.
        var xs = [], vals = [];
        for (var i = 0; i < stamps.length; i++) {
          if (closes[i] === null || closes[i] === undefined) continue;
          xs.push(stamps[i]);
          vals.push(closes[i]);
        }
        if (!xs.length) throw new Error('empty series');

        state.chartData = {
          timestamps: xs,
          closes: vals,
          intraday: r.interval.indexOf('m') > 0
        };
        state.chartData.series = [xs, vals];
        renderChart();
      })
      .catch(function (err) {
        els.chartLoading.hidden = false;
        els.chartLoading.classList.add('chart-error');
        els.chartLoading.textContent = 'Chart unavailable: ' + err.message;
      });
  }

  function renderChartHeader() {
    var q = state.quotes[state.selected];
    var meta = UNIVERSE.filter(function (u) { return u.symbol === state.selected; })[0];
    var name = meta ? meta.name : (q ? q.name : state.selected);

    els.chartHeading.textContent = state.selected + ' · ' + name;
    els.chartSub.textContent = (RANGES[state.range] ? RANGES[state.range].label : '') + (q && q.timezone ? ' · ' + q.timezone : '');

    if (q) {
      els.chartPrice.textContent = fmtPrice(q.price);
      var cls = dirClass(q.changePct);
      els.chartChange.className = 'chart-change ' + cls;
      els.chartChange.textContent = fmtSigned(q.change, 2) + '  ' + fmtPct(q.changePct);
      els.chartCurrency.textContent = q.currency || '';
    }

    var stats = [
      ['Day high', q && q.dayHigh !== undefined ? fmtPrice(q.dayHigh) : '—'],
      ['Day low', q && q.dayLow !== undefined ? fmtPrice(q.dayLow) : '—'],
      ['Prev close', q && q.prevClose !== undefined ? fmtPrice(q.prevClose) : '—'],
      ['Volume', q && q.volume ? fmtCompact(q.volume) : '—'],
      ['52w high', q && q.high52 ? fmtPrice(q.high52) : '—'],
      ['52w low', q && q.low52 ? fmtPrice(q.low52) : '—']
    ];
    els.chartStats.innerHTML = stats.map(function (s) {
      return '<div><div class="stat-label">' + s[0] + '</div><div class="stat-value">' + s[1] + '</div></div>';
    }).join('');
  }

  // --------------------------------------------------------------- refresh

  function setBusy(busy) {
    els.refreshBtn.classList.toggle('is-busy', busy);
    els.refreshBtn.disabled = busy;
  }

  function applyFallbacks(quotes) {
    // Fill any missing crypto/FX quotes from the keyless fallback APIs.
    var needCrypto = UNIVERSE.some(function (u) {
      return u.group === 'crypto' && !quotes[u.symbol];
    });
    var needFx = UNIVERSE.some(function (u) {
      return u.group === 'fx' && !quotes[u.symbol];
    });

    var jobs = [];
    if (needCrypto) {
      jobs.push(fetchCryptoFallback().then(function (out) {
        Object.keys(out).forEach(function (s) {
          if (!quotes[s]) quotes[s] = out[s];
        });
      }).catch(function () {}));
    }
    if (needFx) {
      jobs.push(fetchFxFallback().then(function (out) {
        Object.keys(out).forEach(function (s) {
          if (!quotes[s]) quotes[s] = out[s];
        });
      }).catch(function () {}));
    }
    return Promise.all(jobs);
  }

  function refresh(silent) {
    setBusy(true);
    var started = Date.now();

    return fetchQuotes()
      .then(function (quotes) {
        return applyFallbacks(quotes).then(function () { return quotes; });
      })
      .then(function (quotes) {
        state.quotes = quotes;
        state.stale = false;
        state.source = 'live';
        state.lastUpdate = new Date();
        renderAll();
        renderChartHeader();
        loadChart(state.selected, state.range);
      })
      .catch(function (err) {
        return fetchSnapshot().then(function (snap) {
          var quotes = {};
          Object.keys(snap.quotes).forEach(function (s) {
            quotes[s] = snap.quotes[s];
          });
          state.quotes = quotes;
          state.stale = true;
          state.source = 'snapshot';
          state.lastUpdate = snap.updated ? new Date(snap.updated) : new Date();
          renderAll();
          renderChartHeader();

          // Draw the chart from the snapshot's own close series instead of
          // waiting on a live fetch that has already failed. The snapshot
          // stores closes but not timestamps, so the axis is reconstructed
          // backwards from the quote's market time.
          var q = state.quotes[state.selected];
          var snapData = q
            ? window.PortfolioModel.snapshotChartData(q.closes, q.marketTime, 300)
            : null;

          if (snapData) {
            snapData.series = [snapData.timestamps, snapData.closes];
            state.chartData = snapData;
            renderChart();
            els.chartLoading.hidden = true;
            els.chartLoading.classList.remove('chart-error');
          } else if (!silent) {
            els.chartLoading.hidden = false;
            els.chartLoading.classList.add('chart-error');
            els.chartLoading.textContent = 'Live feed unavailable — showing last snapshot';
          }
        }).catch(function () {
          els.statusDot.className = 'status-dot is-error';
          els.statusLabel.textContent = 'Feed error';
          if (!silent) console.error('[market-dashboard] refresh failed:', err);
        });
      })
      .then(function () {
        setBusy(false);
        return Date.now() - started;
      });
  }

  // --------------------------------------------------------------- events

  function selectSymbol(symbol) {
    if (!symbol) return;
    state.selected = symbol;
    renderIndices();
    renderWatchlist();
    renderPortfolio();
    // Re-render the treemap so the selected tile picks up its highlight.
    if (heatmapData) renderHeatmap();
    renderChartHeader();
    loadChart(symbol, state.range);
  }

  function bindEvents() {
    els.indexGrid.addEventListener('click', function (e) {
      var card = e.target.closest('.index-card');
      if (card) selectSymbol(card.getAttribute('data-symbol'));
    });

    els.auxGrid.addEventListener('click', function (e) {
      var card = e.target.closest('.aux-card');
      if (card) selectSymbol(card.getAttribute('data-symbol'));
    });

    els.watchlistBody.addEventListener('click', function (e) {
      var row = e.target.closest('tr[data-symbol]');
      if (row) selectSymbol(row.getAttribute('data-symbol'));
    });

    if (els.portfolioBody) {
      els.portfolioBody.addEventListener('click', function (e) {
        var row = e.target.closest('tr[data-symbol]');
        if (row) selectSymbol(row.getAttribute('data-symbol'));
      });
    }

    [els.gainersList, els.losersList, els.activeList].forEach(function (list) {
      list.addEventListener('click', function (e) {
        var item = e.target.closest('li[data-symbol]');
        if (item) selectSymbol(item.getAttribute('data-symbol'));
      });
    });

    els.rangeTabs.addEventListener('click', function (e) {
      var tab = e.target.closest('.range-tab');
      if (!tab) return;
      var range = tab.getAttribute('data-range');
      state.range = range;
      Array.prototype.forEach.call(els.rangeTabs.querySelectorAll('.range-tab'), function (t) {
        var active = t === tab;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      renderChartHeader();
      loadChart(state.selected, range);
    });

    // Each table sorts independently — scope the handlers to their own
    // <thead>, and keep separate sort state per table so clicking a
    // portfolio header does not re-sort the watchlist.
    var sortState = {
      watchlist: { key: 'changePct', asc: false },
      portfolio: { key: 'changePct', asc: false }
    };
    state.tableSort = sortState;

    document.querySelectorAll('.quote-table').forEach(function (table) {
      var which = table.classList.contains('portfolio-table') ? 'portfolio' : 'watchlist';
      var heads = table.querySelectorAll('th[data-sort]');
      heads.forEach(function (th) {
        th.addEventListener('click', function () {
          var key = th.getAttribute('data-sort');
          var st = sortState[which];
          if (st.key === key) {
            st.asc = !st.asc;
          } else {
            st.key = key;
            st.asc = key === 'symbol' || key === 'name' || key === 'role';
          }
          heads.forEach(function (other) {
            other.classList.remove('is-sorted', 'is-asc');
          });
          th.classList.add('is-sorted');
          if (st.asc) th.classList.add('is-asc');
          renderWatchlist();
          renderPortfolio();
        });
      });
    });

    els.refreshBtn.addEventListener('click', function () {
      refresh(false);
    });

    // ------------------------------------------------------------ heatmap

    if (els.heatmapCanvas) {
      // Delegated so it keeps working after the treemap is re-rendered.
      els.heatmapCanvas.addEventListener('mouseover', function (e) {
        var tile = e.target.closest('.hm-tile');
        if (tile) showHeatmapTip(tile, e);
      });
      els.heatmapCanvas.addEventListener('mousemove', function (e) {
        var tile = e.target.closest('.hm-tile');
        if (tile) showHeatmapTip(tile, e);
        else hideHeatmapTip();
      });
      els.heatmapCanvas.addEventListener('mouseout', function (e) {
        var tile = e.target.closest('.hm-tile');
        if (tile && !e.relatedTarget) hideHeatmapTip();
      });
      els.heatmapCanvas.addEventListener('click', function (e) {
        var tile = e.target.closest('.hm-tile');
        if (tile) selectSymbol(tile.getAttribute('data-symbol'));
      });
      els.heatmapCanvas.addEventListener('mouseleave', hideHeatmapTip);
    }

    // The treemap geometry depends on the panel's pixel size, so it has to
    // be recomputed when the element actually changes size.
    //
    // A ResizeObserver is used rather than the window's resize event: the
    // observer fires when the canvas's own box changes, which is exactly
    // the measurement the layout needs. The window event can fire before
    // the browser has applied the new viewport, so measuring there yields
    // the OLD width and lays the treemap out for the wrong size.
    if (typeof ResizeObserver !== 'undefined' && els.heatmapCanvas) {
      var lastW = 0, lastH = 0;
      var ro = new ResizeObserver(function (entries) {
        var box = entries[0] && entries[0].contentRect;
        if (!box) return;
        // Ignore sub-pixel jitter.
        if (Math.abs(box.width - lastW) < 1 && Math.abs(box.height - lastH) < 1) return;
        lastW = box.width;
        lastH = box.height;
        if (heatmapData) renderHeatmap();
      });
      ro.observe(els.heatmapCanvas);
    }

    els.autoToggle.addEventListener('click', function () {
      state.auto = !state.auto;
      els.autoToggle.setAttribute('aria-pressed', state.auto ? 'true' : 'false');
      if (state.auto) {
        scheduleRefresh();
        refresh(true);
      } else if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
    });

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (!state.chart) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        var host = els.chartHost;
        state.chart.setSize({ width: host.clientWidth, height: host.clientHeight });
      }, 120);
    });
  }

  function scheduleRefresh() {
    if (state.timer) clearInterval(state.timer);
    if (!state.auto) return;
    state.timer = setInterval(function () { refresh(true); }, REFRESH_MS);
  }

  // ----------------------------------------------------------------- init

  /**
   * Validate the published portfolio data before rendering it.
   *
   * A violated rule (a sensitive field, weights that do not sum to 100) must
   * fail visibly rather than silently publishing the wrong thing.
   */
  function checkPortfolioData() {
    var p = window.PORTFOLIO;
    if (!p || !p.holdings) return;

    var res = window.PortfolioModel.validate(p.holdings);
    if (res.ok) return;

    console.error('[market-dashboard] portfolio data is invalid:\n  - ' + res.problems.join('\n  - '));
    els.portfolioBody.innerHTML =
      '<tr><td colspan="6" class="table-error">Portfolio data failed validation — see the browser console.</td></tr>';
    els.techExposure.textContent = '—';
    els.nonTechExposure.textContent = '—';
    els.holdingCount.textContent = '—';
    els.weightedMove.textContent = '—';
    els.weightedMove.className = 'alloc-figure-value';
    els.sectorStrip.innerHTML = '';
    els.sectorStrip.hidden = true;
  }

  function init() {
    els = {
      statusDot: $('statusDot'),
      statusLabel: $('statusLabel'),
      lastUpdate: $('lastUpdate'),
      autoToggle: $('autoToggle'),
      refreshBtn: $('refreshBtn'),
      tickerTrack: $('tickerTrack'),
      indexGrid: $('indexGrid'),
      indicesNote: $('indicesNote'),
      chartHeading: $('chartHeading'),
      chartSub: $('chartSub'),
      chartPrice: $('chartPrice'),
      chartChange: $('chartChange'),
      chartCurrency: $('chartCurrency'),
      chartHost: $('chartHost'),
      chartLoading: $('chartLoading'),
      chartStats: $('chartStats'),
      rangeTabs: $('rangeTabs'),
      portfolioBody: $('portfolioBody'),
      sectorStrip: $('sectorStrip'),
      techExposure: $('techExposure'),
      nonTechExposure: $('nonTechExposure'),
      holdingCount: $('holdingCount'),
      weightedMove: $('weightedMove'),
      watchlistBody: $('watchlistBody'),
      gainersList: $('gainersList'),
      losersList: $('losersList'),
      activeList: $('activeList'),
      auxGrid: $('auxGrid'),
      auxNote: $('auxNote'),
      heatmapCanvas: $('heatmapCanvas'),
      heatmapLoading: $('heatmapLoading'),
      heatmapNote: $('heatmapNote'),
      heatmapTip: $('heatmapTip')
    };

    // Default sort markers on the initial sort column of each table.
    var watchTh = document.querySelector('.quote-table:not(.portfolio-table) th[data-sort="changePct"]');
    if (watchTh) watchTh.classList.add('is-sorted');
    var portTh = document.querySelector('.portfolio-table th[data-sort="changePct"]');
    if (portTh) portTh.classList.add('is-sorted');

    bindEvents();
    checkPortfolioData();
    initHeatmap();
    refresh(true).then(function () {
      scheduleRefresh();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
