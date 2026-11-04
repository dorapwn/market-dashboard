/*
 * Fundamentals model — the financial information shown under the chart.
 *
 * The dashboard tracks quotes for indices, equities, crypto and FX. Only
 * equities have financial statements, so this module turns Yahoo's
 * fundamentals-timeseries payload into the numbers worth showing: revenue,
 * cash flow, margins and valuation.
 *
 * Two things make this more than a matter of dividing numbers:
 *
 *   1. CURRENCY. Yahoo reports a Hong Kong stock's statements in CNY but
 *      its market cap in HKD, and the price is in HKD too. Dividing the
 *      HKD price by the CNY earnings per share gives a P/E that is wrong
 *      by the CNY/HKD rate — about 18%. So the price and the earnings have
 *      to be in the same currency before they are divided, and when they
 *      are not, the model refuses to guess.
 *
 *   2. PERIODS. The `trailing*` flow series has exactly two points and
 *      they are not a year apart: Microsoft returns 2025-06-30 and
 *      2026-09-30. Treating that as "year over year" reports +22.97% when
 *      the honest fiscal-year figure is +17.80%. Growth therefore comes
 *      from the `annual*` series, which has one point per fiscal year.
 *
 * No DOM, no fetch, no globals. Browser + Node share this file.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FundamentalsModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * The trailing (TTM) figures shown for the current state of the business.
   * Each key maps to the Yahoo timeseries type that carries it.
   */
  var TTM_TYPES = {
    revenue: 'trailingTotalRevenue',
    grossProfit: 'trailingGrossProfit',
    operatingIncome: 'trailingOperatingIncome',
    netIncome: 'trailingNetIncome',
    ebitda: 'trailingEBITDA',
    costOfRevenue: 'trailingCostOfRevenue',
    totalExpenses: 'trailingTotalExpenses',
    operatingCashFlow: 'trailingOperatingCashFlow',
    freeCashFlow: 'trailingFreeCashFlow',
    capex: 'trailingCapitalExpenditure',
    dilutedEps: 'trailingDilutedEPS',
    dilutedShares: 'trailingDilutedAverageShares',
    marketCap: 'trailingMarketCap'
  };

  /**
   * The annual figures, used for the fiscal-year comparison.
   */
  var ANNUAL_TYPES = {
    revenue: 'annualTotalRevenue',
    freeCashFlow: 'annualFreeCashFlow',
    dilutedEps: 'annualDilutedEPS'
  };

  /**
   * The balance sheet, taken from the most recent quarter.
   */
  var QUARTERLY_TYPES = {
    totalAssets: 'quarterlyTotalAssets',
    equity: 'quarterlyStockholdersEquity',
    cash: 'quarterlyCashAndCashEquivalents',
    totalDebt: 'quarterlyTotalDebt'
  };

  /** The Yahoo types this module asks for, in one request. */
  function requestTypes() {
    var out = [];
    Object.keys(TTM_TYPES).forEach(function (k) { out.push(TTM_TYPES[k]); });
    Object.keys(ANNUAL_TYPES).forEach(function (k) { out.push(ANNUAL_TYPES[k]); });
    Object.keys(QUARTERLY_TYPES).forEach(function (k) { out.push(QUARTERLY_TYPES[k]); });
    return out;
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /** The last point of a Yahoo series, or null. */
  function lastPoint(series) {
    if (!series || !series.length) return null;
    var p = series[series.length - 1];
    if (!p || !p.reportedValue) return null;
    var raw = p.reportedValue.raw;
    if (!isNum(raw)) return null;
    return { value: raw, date: p.asOfDate || null, currency: p.currencyCode || null };
  }

  /** The whole series, as {value, date, currency} points. */
  function points(series) {
    if (!series || !series.length) return [];
    return series.filter(function (p) {
      return p && p.reportedValue && isNum(p.reportedValue.raw);
    }).map(function (p) {
      return {
        value: p.reportedValue.raw,
        date: p.asOfDate || null,
        currency: p.currencyCode || null
      };
    });
  }

  /**
   * Parse Yahoo's payload into the shape the rest of the app uses.
   *
   * Returns null when there is nothing to show — an index, an FX pair or
   * a crypto coin has no financial statements, and the panel should then
   * be absent rather than empty.
   */
  function parse(payload, symbol) {
    if (!payload) return null;
    var result = (payload.timeseries && payload.timeseries.result) || [];
    if (!result.length) return null;

    // Index the payload by type. Yahoo returns one entry per type, each
    // with its own "meta".
    var byType = {};
    result.forEach(function (entry) {
      Object.keys(entry).forEach(function (key) {
        if (key === 'meta' || key === 'timestamp') return;
        byType[key] = entry[key];
      });
    });

    function pick(map) {
      var out = {};
      Object.keys(map).forEach(function (k) {
        out[k] = lastPoint(byType[map[k]]);
      });
      return out;
    }

    function pickAll(map) {
      var out = {};
      Object.keys(map).forEach(function (k) {
        out[k] = points(byType[map[k]]);
      });
      return out;
    }

    var ttm = pick(TTM_TYPES);
    // Revenue is the one figure without which there is nothing to say.
    if (!ttm.revenue) return null;

    var annual = pickAll(ANNUAL_TYPES);
    var quarterly = pick(QUARTERLY_TYPES);

    // The reporting currency comes from the statements, not the market cap:
    // the market cap of a Hong Kong stock is in HKD while its statements
    // are in CNY.
    var currency = null;
    ['revenue', 'netIncome', 'freeCashFlow', 'grossProfit', 'operatingIncome']
      .forEach(function (k) {
        if (!currency && ttm[k] && ttm[k].currency) currency = ttm[k].currency;
      });

    return {
      symbol: symbol,
      currency: currency,
      asOf: ttm.revenue.date,
      ttm: ttm,
      annual: annual,
      quarterly: quarterly
    };
  }

  /**
   * Divide two numbers, or return null if either is missing.
   */
  function ratio(a, b) {
    if (!isNum(a) || !isNum(b) || b === 0) return null;
    return a / b;
  }

  /** Percentage change from a to b, or null. */
  function pctChange(a, b) {
    if (!isNum(a) || !isNum(b) || a === 0) return null;
    return ((b / a) - 1) * 100;
  }

  /**
   * The fiscal-year-over-fiscal-year change for an annual series.
   *
   * The series is one point per fiscal year, so the last two points are
   * the comparison. Returns null when there is not a full pair.
   */
  function annualGrowth(series) {
    if (!series || series.length < 2) return null;
    var prev = series[series.length - 2];
    var last = series[series.length - 1];
    var pct = pctChange(prev.value, last.value);
    if (pct === null) return null;
    return { pct: pct, from: prev.date, to: last.date };
  }

  /**
   * Turn the parsed payload into the numbers to display.
   *
   * `opts.price` is the last traded price, `opts.quoteCurrency` the
   * currency that price is in, and `opts.fxRate` the multiplier that
   * converts the reporting currency into the quote currency.
   */
  function derive(parsed, opts) {
    opts = opts || {};
    var ttm = parsed.ttm;
    var notes = [];

    // Does the money in the statements match the money in the price?
    // A Hong Kong stock is the case that matters: CNY statements, HKD price.
    var reportCurrency = parsed.currency;
    var quoteCurrency = opts.quoteCurrency || null;
    var crossCurrency = !!(reportCurrency && quoteCurrency &&
      reportCurrency !== quoteCurrency);
    var rate = isNum(opts.fxRate) && opts.fxRate > 0 ? opts.fxRate : null;

    if (crossCurrency && !rate) {
      // Without a rate the ratio would be wrong, so it is not computed.
      // The note says why, rather than showing a plausible wrong number.
      notes.push('P/E needs a ' + reportCurrency + '/' + quoteCurrency +
        ' rate, which is unavailable right now.');
    }

    // Money in the quote currency, so it can be compared with the price.
    function money(v) {
      if (!isNum(v)) return null;
      if (crossCurrency && rate) return v * rate;
      return v;
    }

    // A ratio of two statement figures is unaffected by the currency, so
    // it is always computed from the reported values.
    var revenue = ttm.revenue ? ttm.revenue.value : null;
    var grossMargin = ratio(ttm.grossProfit ? ttm.grossProfit.value : null, revenue);
    var operatingMargin = ratio(ttm.operatingIncome ? ttm.operatingIncome.value : null, revenue);
    var netMargin = ratio(ttm.netIncome ? ttm.netIncome.value : null, revenue);

    // Per-share figures need the earnings and the price in one currency.
    var eps = ttm.dilutedEps ? ttm.dilutedEps.value : null;
    var epsInQuote = (crossCurrency && rate) ? eps * rate : eps;
    var pe = null;
    // Without a rate the two are in different currencies, so the ratio
    // would be wrong. It is left empty rather than shown wrong.
    var canCompare = !crossCurrency || !!rate;
    if (canCompare && isNum(opts.price) && isNum(epsInQuote) && epsInQuote > 0) {
      pe = opts.price / epsInQuote;
    }

    var shares = ttm.dilutedShares ? ttm.dilutedShares.value : null;
    var fcf = ttm.freeCashFlow ? ttm.freeCashFlow.value : null;
    var fcfPerShare = ratio(fcf, shares);

    // The market cap is in the QUOTE currency (Yahoo reports a Hong Kong
    // stock's market cap in HKD even though its statements are in CNY), so
    // the cash flow has to be converted before the two are divided.
    var marketCap = ttm.marketCap ? ttm.marketCap.value : null;
    var priceToFcf = null;
    var fcfYield = null;
    if (isNum(marketCap) && isNum(fcf) && fcf > 0 && canCompare) {
      var fcfInQuote = money(fcf);
      priceToFcf = marketCap / fcfInQuote;
      fcfYield = (fcfInQuote / marketCap) * 100;
    }

    // Net debt comes from the balance sheet, which is in the reporting
    // currency — so it is converted before it meets the market cap.
    var cash = parsed.quarterly.cash ? parsed.quarterly.cash.value : null;
    var debt = parsed.quarterly.totalDebt ? parsed.quarterly.totalDebt.value : null;
    var netDebt = (isNum(cash) && isNum(debt)) ? money(debt - cash) : null;

    return {
      symbol: parsed.symbol,
      available: true,
      currency: reportCurrency,
      quoteCurrency: quoteCurrency,
      crossCurrency: crossCurrency,
      fxRate: rate,
      asOf: parsed.asOf,
      notes: notes,
      valuation: {
        pe: pe,
        priceToFcf: priceToFcf,
        fcfYield: fcfYield,
        marketCap: marketCap,
        eps: eps
      },
      cashflow: {
        operatingCashFlow: money(ttm.operatingCashFlow ? ttm.operatingCashFlow.value : null),
        freeCashFlow: money(fcf),
        capex: money(ttm.capex ? ttm.capex.value : null),
        freeCashFlowPerShare: fcfPerShare
      },
      profitability: {
        revenue: money(revenue),
        grossProfit: money(ttm.grossProfit ? ttm.grossProfit.value : null),
        operatingIncome: money(ttm.operatingIncome ? ttm.operatingIncome.value : null),
        netIncome: money(ttm.netIncome ? ttm.netIncome.value : null),
        grossMargin: grossMargin,
        operatingMargin: operatingMargin,
        netMargin: netMargin
      },
      balance: {
        totalAssets: money(parsed.quarterly.totalAssets ? parsed.quarterly.totalAssets.value : null),
        equity: money(parsed.quarterly.equity ? parsed.quarterly.equity.value : null),
        cash: money(cash),
        totalDebt: money(debt),
        netDebt: netDebt
      },
      growth: {
        revenue: annualGrowth(parsed.annual.revenue),
        freeCashFlow: annualGrowth(parsed.annual.freeCashFlow),
        eps: annualGrowth(parsed.annual.dilutedEps)
      }
    };
  }

  /**
   * The annual figures as rows, one per fiscal year, ready to chart.
   */
  function fiscalSeries(parsed) {
    var revenue = parsed.annual.revenue || [];
    var fcf = parsed.annual.freeCashFlow || [];
    var eps = parsed.annual.dilutedEps || [];

    function at(series, date) {
      for (var i = 0; i < series.length; i++) {
        if (series[i].date === date) return series[i].value;
      }
      return null;
    }

    return revenue.map(function (p) {
      return {
        date: p.date,
        label: fiscalLabel(p.date),
        revenue: p.value,
        freeCashFlow: at(fcf, p.date),
        dilutedEps: at(eps, p.date)
      };
    });
  }

  /**
   * The fiscal-year label for a period end.
   *
   * A company whose year ends in June 2026 is in FY2026, so the label
   * takes the year from the end date — not the year the year started.
   */
  function fiscalLabel(date) {
    if (!date || typeof date !== 'string') return '';
    var year = parseInt(date.slice(0, 4), 10);
    if (!isFinite(year)) return '';
    return 'FY' + String(year).slice(-2);
  }

  /**
   * The metrics to display, grouped for the panel.
   *
   * A metric with no value is still listed — the reader wants to know it
   * is absent, not to have it silently disappear.
   */
  function groupMetrics(derived) {
    var d = derived;
    var growth = function (g) { return g && isNum(g.pct) ? g.pct : null; };

    return [
      {
        key: 'valuation',
        title: 'Valuation',
        metrics: [
          { key: 'pe', label: 'P/E (TTM)', kind: 'ratio', value: d.valuation.pe },
          { key: 'priceToFcf', label: 'P/FCF', kind: 'ratio', value: d.valuation.priceToFcf },
          { key: 'fcfYield', label: 'FCF yield', kind: 'percent', value: d.valuation.fcfYield },
          { key: 'eps', label: 'EPS (TTM)', kind: 'money', value: d.valuation.eps }
        ]
      },
      {
        key: 'cashflow',
        title: 'Cash flow',
        metrics: [
          { key: 'operatingCashFlow', label: 'Operating CF', kind: 'money', value: d.cashflow.operatingCashFlow },
          { key: 'freeCashFlow', label: 'Free CF', kind: 'money', value: d.cashflow.freeCashFlow },
          { key: 'capex', label: 'Capex', kind: 'money', value: d.cashflow.capex },
          { key: 'freeCashFlowPerShare', label: 'FCF / share', kind: 'moneyPerShare', value: d.cashflow.freeCashFlowPerShare }
        ]
      },
      {
        key: 'profitability',
        title: 'Profitability',
        metrics: [
          { key: 'revenue', label: 'Revenue (TTM)', kind: 'money', value: d.profitability.revenue },
          // A margin is a ratio (0.677 means 67.7%), so it needs its own
          // kind — the "percent" kind is for values already in 0-100.
          { key: 'grossMargin', label: 'Gross margin', kind: 'ratioPercent', value: d.profitability.grossMargin },
          { key: 'operatingMargin', label: 'Operating margin', kind: 'ratioPercent', value: d.profitability.operatingMargin },
          { key: 'netMargin', label: 'Net margin', kind: 'ratioPercent', value: d.profitability.netMargin },
          { key: 'revenueGrowth', label: 'Revenue YoY', kind: 'percent', value: growth(d.growth.revenue) }
        ]
      },
      {
        key: 'balance',
        title: 'Balance sheet',
        metrics: [
          { key: 'totalAssets', label: 'Total assets', kind: 'money', value: d.balance.totalAssets },
          { key: 'equity', label: 'Shareholders equity', kind: 'money', value: d.balance.equity },
          { key: 'cash', label: 'Cash', kind: 'money', value: d.balance.cash },
          { key: 'totalDebt', label: 'Total debt', kind: 'money', value: d.balance.totalDebt },
          { key: 'netDebt', label: 'Net debt', kind: 'money', value: d.balance.netDebt }
        ]
      }
    ];
  }

  return {
    TTM_TYPES: TTM_TYPES,
    ANNUAL_TYPES: ANNUAL_TYPES,
    QUARTERLY_TYPES: QUARTERLY_TYPES,
    requestTypes: requestTypes,
    parse: parse,
    derive: derive,
    fiscalSeries: fiscalSeries,
    fiscalLabel: fiscalLabel,
    groupMetrics: groupMetrics
  };
});
