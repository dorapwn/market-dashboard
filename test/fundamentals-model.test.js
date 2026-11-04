/*
 * Tests for the fundamentals model.
 *
 * The dashboard shows financial information under the chart — revenue,
 * cash flow, margins, P/E — for whichever instrument is selected. The
 * arithmetic lives in a pure module so it can be tested without a browser.
 *
 * Two traps this file exists to catch:
 *
 *   1. Yahoo reports a Hong Kong stock's financials in CNY but its market
 *      cap in HKD. Dividing one by the other without converting gives a
 *      P/E that is wrong by the CNY/HKD rate (~18%).
 *   2. The `trailing*` flow series has only two points and they are NOT a
 *      year apart (Microsoft: 2025-06-30 and 2026-09-30). Growth must come
 *      from the `annual*` series, which is one point per fiscal year.
 *
 * Run with: npm test   (node --test, no dependencies)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../assets/fundamentals-model.js');

// ------------------------------------------------------------- fixtures

/** One Yahoo timeseries point. */
function pt(raw, date, currency, fmt) {
  return {
    dataId: 1,
    asOfDate: date,
    periodType: '12M',
    currencyCode: currency || 'USD',
    reportedValue: { raw, fmt: fmt || String(raw) }
  };
}

/**
 * A payload shaped like Yahoo's, with Microsoft-like numbers.
 * The trailing flow series carries two points that are 15 months apart,
 * which is exactly what Yahoo returns.
 */
const MSFT_PAYLOAD = {
  timeseries: {
    result: [
      { meta: { symbol: ['MSFT'] },
        trailingTotalRevenue: [
          pt(281724000000, '2025-06-30'),
          pt(346445000000, '2026-09-30')
        ] },
      { meta: { symbol: ['MSFT'] },
        trailingGrossProfit: [pt(234390000000, '2026-09-30')] },
      { meta: { symbol: ['MSFT'] },
        trailingOperatingIncome: [pt(163190000000, '2026-09-30')] },
      { meta: { symbol: ['MSFT'] },
        trailingNetIncome: [pt(142630000000, '2026-09-30')] },
      { meta: { symbol: ['MSFT'] },
        trailingOperatingCashFlow: [pt(195880000000, '2026-09-30')] },
      { meta: { symbol: ['MSFT'] },
        trailingFreeCashFlow: [pt(59960000000, '2026-09-30')] },
      { meta: { symbol: ['MSFT'] },
        trailingCapitalExpenditure: [pt(-135920000000, '2026-09-30')] },
      { meta: { symbol: ['MSFT'] },
        trailingDilutedEPS: [
          pt(14.06, '2025-09-30'),
          pt(19.15, '2026-09-30')
        ] },
      { meta: { symbol: ['MSFT'] },
        trailingDilutedAverageShares: [pt(7448000000, '2026-09-30')] },
      { meta: { symbol: ['MSFT'] },
        trailingMarketCap: [pt(3765971781210, '2026-11-02', null)] },
      { meta: { symbol: ['MSFT'] },
        annualTotalRevenue: [
          pt(198270000000, '2023-06-30'),
          pt(245122000000, '2024-06-30'),
          pt(281724000000, '2025-06-30'),
          pt(331840000000, '2026-06-30')
        ] },
      { meta: { symbol: ['MSFT'] },
        annualFreeCashFlow: [
          pt(59475000000, '2023-06-30'),
          pt(74071000000, '2024-06-30'),
          pt(71611000000, '2025-06-30'),
          pt(66987000000, '2026-06-30')
        ] },
      { meta: { symbol: ['MSFT'] },
        annualDilutedEPS: [
          pt(9.68, '2023-06-30'),
          pt(11.80, '2024-06-30'),
          pt(13.64, '2025-06-30'),
          pt(17.95, '2026-06-30')
        ] },
      { meta: { symbol: ['MSFT'] },
        quarterlyTotalAssets: [pt(779400000000, '2026-09-30')] },
      { meta: { symbol: ['MSFT'] },
        quarterlyStockholdersEquity: [pt(470510000000, '2026-09-30')] },
      { meta: { symbol: ['MSFT'] },
        quarterlyCashAndCashEquivalents: [pt(20280000000, '2026-09-30')] },
      { meta: { symbol: ['MSFT'] },
        quarterlyTotalDebt: [pt(57200000000, '2026-09-30')] }
    ]
  }
};

/** A Hong Kong stock: statements in CNY, market cap in HKD. */
const TENCENT_PAYLOAD = {
  timeseries: {
    result: [
      { meta: { symbol: ['0700.HK'] },
        trailingTotalRevenue: [pt(788480000000, '2026-06-30', 'CNY')] },
      { meta: { symbol: ['0700.HK'] },
        trailingNetIncome: [pt(235510000000, '2026-06-30', 'CNY')] },
      { meta: { symbol: ['0700.HK'] },
        trailingFreeCashFlow: [pt(143250000000, '2026-06-30', 'CNY')] },
      { meta: { symbol: ['0700.HK'] },
        trailingDilutedEPS: [pt(25.44, '2026-06-30', 'CNY')] },
      { meta: { symbol: ['0700.HK'] },
        trailingMarketCap: [pt(3580000000000, '2026-11-03', 'HKD')] }
    ]
  }
};

// ----------------------------------------------------------------- parse

test('parse returns null for an empty payload', () => {
  assert.equal(model.parse(null, 'MSFT'), null);
  assert.equal(model.parse({ timeseries: { result: [] } }, 'MSFT'), null);
});

test('parse returns null when there is no revenue — an index has no financials', () => {
  const payload = { timeseries: { result: [{ meta: {}, trailingTotalRevenue: [] }] } };
  assert.equal(model.parse(payload, '^GSPC'), null);
});

test('parse extracts the trailing figures', () => {
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  assert.equal(r.symbol, 'MSFT');
  assert.equal(r.currency, 'USD');
  assert.equal(r.asOf, '2026-09-30');
  assert.equal(r.ttm.revenue.value, 346445000000);
  assert.equal(r.ttm.freeCashFlow.value, 59960000000);
  assert.equal(r.ttm.capex.value, -135920000000);
  assert.equal(r.ttm.dilutedEps.value, 19.15);
});

test('parse keeps the annual series for the fiscal-year comparison', () => {
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  assert.equal(r.annual.revenue.length, 4);
  assert.equal(r.annual.revenue[3].value, 331840000000);
  assert.equal(r.annual.revenue[3].date, '2026-06-30');
});

test('parse reads the quarterly balance sheet', () => {
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  assert.equal(r.quarterly.cash.value, 20280000000);
  assert.equal(r.quarterly.totalDebt.value, 57200000000);
});

test('parse takes the most recent point when a series has several', () => {
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  assert.equal(r.ttm.dilutedEps.value, 19.15);
  assert.equal(r.ttm.dilutedEps.date, '2026-09-30');
});

// ---------------------------------------------------------------- derive

test('derive computes the trailing P/E from the price and the trailing EPS', () => {
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  const d = model.derive(r, { price: 507.12, quoteCurrency: 'USD' });
  assert.equal(d.available, true);
  assert.ok(Math.abs(d.valuation.pe - (507.12 / 19.15)) < 0.01, String(d.valuation.pe));
});

test('derive computes the margins', () => {
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  const d = model.derive(r, { price: 507.12, quoteCurrency: 'USD' });
  assert.ok(Math.abs(d.profitability.grossMargin - (234390 / 346445)) < 1e-6);
  assert.ok(Math.abs(d.profitability.operatingMargin - (163190 / 346445)) < 1e-6);
  assert.ok(Math.abs(d.profitability.netMargin - (142630 / 346445)) < 1e-6);
});

test('derive computes free cash flow per share', () => {
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  const d = model.derive(r, { price: 507.12, quoteCurrency: 'USD' });
  assert.ok(Math.abs(d.cashflow.freeCashFlowPerShare - (59960 / 7448)) < 0.01,
    String(d.cashflow.freeCashFlowPerShare));
});

test('derive computes the P/FCF and the FCF yield', () => {
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  const d = model.derive(r, { price: 507.12, quoteCurrency: 'USD' });
  assert.ok(Math.abs(d.valuation.priceToFcf - (3765971781210 / 59960000000)) < 1);
  assert.ok(Math.abs(d.valuation.fcfYield - (59960000000 / 3765971781210) * 100) < 1e-6);
});

test('derive takes growth from the annual series, not the trailing one', () => {
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  const d = model.derive(r, { price: 507.12, quoteCurrency: 'USD' });
  // FY26 revenue 331.84B against FY25 281.72B.
  assert.ok(Math.abs(d.growth.revenue.pct - ((331840 / 281724) - 1) * 100) < 0.01,
    String(d.growth.revenue.pct));
  assert.equal(d.growth.revenue.from, '2025-06-30');
  assert.equal(d.growth.revenue.to, '2026-06-30');
});

test('derive does NOT read growth out of the two trailing points', () => {
  // The trailing revenue points are 2025-06-30 and 2026-09-30 — 15 months
  // apart, not a year. Using them would report +22.97% when the honest
  // fiscal-year figure is +17.80%.
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  const d = model.derive(r, { price: 507.12, quoteCurrency: 'USD' });
  assert.ok(d.growth.revenue.pct < 20, String(d.growth.revenue.pct));
});

test('derive computes the EPS growth from the annual series', () => {
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  const d = model.derive(r, { price: 507.12, quoteCurrency: 'USD' });
  assert.ok(Math.abs(d.growth.eps.pct - ((17.95 / 13.64) - 1) * 100) < 0.01,
    String(d.growth.eps.pct));
});

test('derive reports the net debt', () => {
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  const d = model.derive(r, { price: 507.12, quoteCurrency: 'USD' });
  assert.equal(d.balance.netDebt, 57200000000 - 20280000000);
});

// ------------------------------------------------- the currency trap

test('derive refuses a cross-currency P/E when no rate is given', () => {
  // Tencent: statements in CNY, price in HKD. Without a rate, a P/E would
  // be wrong by the CNY/HKD rate.
  const r = model.parse(TENCENT_PAYLOAD, '0700.HK');
  const d = model.derive(r, { price: 394, quoteCurrency: 'HKD' });
  assert.equal(d.valuation.pe, null);
  assert.equal(d.crossCurrency, true);
  assert.ok(d.notes.length > 0);
});

test('derive converts a cross-currency P/E when a rate is given', () => {
  const r = model.parse(TENCENT_PAYLOAD, '0700.HK');
  const d = model.derive(r, { price: 394, quoteCurrency: 'HKD', fxRate: 1.1759 });
  const expected = 394 / (25.44 * 1.1759);
  assert.ok(Math.abs(d.valuation.pe - expected) < 0.01, String(d.valuation.pe));
  assert.equal(d.crossCurrency, true);
});

test('derive does not flag a same-currency instrument as cross-currency', () => {
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  const d = model.derive(r, { price: 507.12, quoteCurrency: 'USD' });
  assert.equal(d.crossCurrency, false);
  assert.equal(d.notes.length, 0);
});

test('derive leaves the margins alone when the currency is converted', () => {
  // A margin is a ratio of two statement figures, so converting the money
  // must not change it.
  const r = model.parse(TENCENT_PAYLOAD, '0700.HK');
  const d = model.derive(r, { price: 394, quoteCurrency: 'HKD', fxRate: 1.1759 });
  assert.ok(Math.abs(d.profitability.netMargin - (235510 / 788480)) < 1e-6);
});

test('derive converts the money into the quote currency when a rate is given', () => {
  const r = model.parse(TENCENT_PAYLOAD, '0700.HK');
  const d = model.derive(r, { price: 394, quoteCurrency: 'HKD', fxRate: 1.1759 });
  // 143.25B CNY converted to HKD.
  assert.ok(Math.abs(d.cashflow.freeCashFlow - (143250000000 * 1.1759)) < 1,
    String(d.cashflow.freeCashFlow));
});

// ---------------------------------------------------------- fiscal bars

test('fiscalSeries aligns the annual series by their period end', () => {
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  const rows = model.fiscalSeries(r);
  assert.equal(rows.length, 4);
  assert.equal(rows[3].date, '2026-06-30');
  assert.equal(rows[3].revenue, 331840000000);
  assert.equal(rows[3].freeCashFlow, 66987000000);
  assert.equal(rows[3].dilutedEps, 17.95);
});

test('fiscalSeries labels the fiscal year', () => {
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  const rows = model.fiscalSeries(r);
  assert.equal(rows[3].label, 'FY26');
  assert.equal(rows[0].label, 'FY23');
});

// ------------------------------------------------------------- grouping

test('groupMetrics returns the four display groups', () => {
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  const d = model.derive(r, { price: 507.12, quoteCurrency: 'USD' });
  const groups = model.groupMetrics(d);
  assert.deepEqual(groups.map((g) => g.key), ['valuation', 'cashflow', 'profitability', 'balance']);
});

test('groupMetrics marks every metric with a formatting kind', () => {
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  const d = model.derive(r, { price: 507.12, quoteCurrency: 'USD' });
  model.groupMetrics(d).forEach((g) => {
    g.metrics.forEach((m) => {
      assert.equal(typeof m.label, 'string');
      assert.ok(m.kind, JSON.stringify(m));
    });
  });
});

test('groupMetrics still lists a metric whose value is missing', () => {
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  const d = model.derive(r, { price: null, quoteCurrency: 'USD' });
  const groups = model.groupMetrics(d);
  const all = groups.reduce((acc, g) => acc.concat(g.metrics), []);
  const pe = all.find((m) => m.key === 'pe');
  assert.ok(pe, 'the P/E is still listed');
  assert.equal(pe.value, null);
});

test('a margin is marked as a ratio, not as a percentage', () => {
  // A margin is a ratio: 0.677 means 67.7%. If it were marked as a
  // percentage the panel would show "+0.7%" instead of "67.7%".
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  const d = model.derive(r, { price: 507.12, quoteCurrency: 'USD' });
  const all = model.groupMetrics(d).reduce((acc, g) => acc.concat(g.metrics), []);
  const gross = all.find((m) => m.key === 'grossMargin');
  assert.equal(gross.kind, 'ratioPercent');
  // The revenue growth is already in 0-100, so it keeps the plain kind.
  const revGrowth = all.find((m) => m.key === 'revenueGrowth');
  assert.equal(revGrowth.kind, 'percent');
});

test('the FCF yield is marked as a percentage, not a ratio', () => {
  // The FCF yield is already in 0-100 (2.3 means 2.3%).
  const r = model.parse(MSFT_PAYLOAD, 'MSFT');
  const d = model.derive(r, { price: 507.12, quoteCurrency: 'USD' });
  const all = model.groupMetrics(d).reduce((acc, g) => acc.concat(g.metrics), []);
  const y = all.find((m) => m.key === 'fcfYield');
  assert.equal(y.kind, 'percent');
  assert.ok(y.value > 0 && y.value < 100, String(y.value));
});
