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

  /** Pull live quotes for the whole universe, respecting Yahoo's 20-symbol cap. */
  function fetchQuotes() {
    var symbols = UNIVERSE.map(function (u) { return u.symbol; });
    var groups = chunk(symbols, SPARK_MAX_SYMBOLS);

    return Promise.all(groups.map(function (group) {
      var q = 'symbols=' + encodeURIComponent(group.join(',')) + '&range=1d&interval=5m';
      return fetchYahoo(YAHOO_SPARK, q);
    })).then(function (payloads) {
      var quotes = {};
      payloads.forEach(function (payload) {
        var results = (payload.spark && payload.spark.result) || [];
        results.forEach(function (entry) {
          var resp = entry.response && entry.response[0];
          if (!resp || !resp.meta) return;
          quotes[entry.symbol] = quoteFromSpark(entry.symbol, resp.meta, resp.indicators && resp.indicators.quote && resp.indicators.quote[0]);
        });
      });
      if (!Object.keys(quotes).length) throw new Error('no quotes returned');
      return quotes;
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
    var key = state.sortKey;
    var dir = state.sortAsc ? 1 : -1;
    return list.slice().sort(function (a, b) {
      var av = a[key], bv = b[key];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
  }

  function renderWatchlist() {
    var body = els.watchlistBody;
    var list = Object.keys(state.quotes).map(function (s) {
      var q = state.quotes[s];
      var meta = UNIVERSE.filter(function (u) { return u.symbol === s; })[0];
      q.group = meta ? meta.group : 'equity';
      q.displayName = meta ? meta.name : q.name;
      return q;
    });
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
    var list = Object.keys(state.quotes).map(function (s) { return state.quotes[s]; })
      .filter(function (q) { return q.group !== 'fx'; });

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
    renderWatchlist();
    renderMovers();
    renderAux();
    renderStatus();
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
          if (!silent) {
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

    document.querySelectorAll('.quote-table th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        if (state.sortKey === key) {
          state.sortAsc = !state.sortAsc;
        } else {
          state.sortKey = key;
          state.sortAsc = key === 'symbol' || key === 'name';
        }
        document.querySelectorAll('.quote-table th[data-sort]').forEach(function (other) {
          other.classList.remove('is-sorted', 'is-asc');
        });
        th.classList.add('is-sorted');
        if (state.sortAsc) th.classList.add('is-asc');
        renderWatchlist();
      });
    });

    els.refreshBtn.addEventListener('click', function () {
      refresh(false);
    });

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
      watchlistBody: $('watchlistBody'),
      gainersList: $('gainersList'),
      losersList: $('losersList'),
      activeList: $('activeList'),
      auxGrid: $('auxGrid'),
      auxNote: $('auxNote')
    };

    // Default sort marker on the Change % column.
    var pctTh = document.querySelector('.quote-table th[data-sort="changePct"]');
    if (pctTh) pctTh.classList.add('is-sorted');

    bindEvents();
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
