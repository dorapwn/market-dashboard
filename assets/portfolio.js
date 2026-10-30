/*
 * Portfolio allocation — public-safe view of the investment plan.
 *
 * DELIBERATELY EXCLUDED (never add these here):
 *   - absolute dollar amounts / cost basis / total portfolio value
 *   - share counts
 *   - broker, tax or account details
 *   - personal decision rules, valuation targets and watchlist rationale
 *   - the name or location of the private source document
 *
 * What is here is allocation *weights* (ratios, no absolute size) plus a
 * one-line role per holding, alongside live market data fetched at runtime.
 *
 * Allocation weights: total 100%.
 */

window.PORTFOLIO = {
  // Holdings, ordered by allocation weight (descending).
  holdings: [
    { symbol: 'VGT',   role: 'Broad tech core',      sector: 'Tech ETF',      group: 'tech', weight: 17.5 },
    { symbol: 'META',  role: 'Open-source platform', sector: 'Tech',          group: 'tech', weight: 15.0 },
    { symbol: 'GOOGL', role: 'Value search & ads',   sector: 'Tech',          group: 'tech', weight: 12.5 },
    { symbol: 'SMH',   role: 'Semiconductors',       sector: 'Tech ETF',      group: 'tech', weight: 10.0 },
    { symbol: 'VST',   role: 'AI power generation',  sector: 'Utility',       group: 'nontech', weight: 8.75 },
    { symbol: 'MSFT',  role: 'Mega-cap platform',    sector: 'Tech',          group: 'tech', weight: 7.5 },
    { symbol: 'NVDA',  role: 'AI infrastructure',    sector: 'Tech',          group: 'tech', weight: 6.25 },
    { symbol: 'AAPL',  role: 'Consumer tech',        sector: 'Tech',          group: 'tech', weight: 5.0 },
    { symbol: 'XLV',   role: 'Healthcare basket',    sector: 'Healthcare',    group: 'nontech', weight: 5.0 },
    { symbol: 'NEE',   role: 'Defensive utility',    sector: 'Utility',       group: 'nontech', weight: 3.75 },
    { symbol: 'ARKX',  role: 'Space basket',         sector: 'Space',         group: 'nontech', weight: 3.75 },
    { symbol: 'SPCX',  role: 'SpaceX direct',        sector: 'Space',         group: 'nontech', weight: 2.5 },
    { symbol: 'IHI',   role: 'Medical devices',      sector: 'Healthcare',    group: 'nontech', weight: 2.5 }
  ],

  // Sector buckets for the concentration strip.
  sectorOrder: ['Tech ETF', 'Tech', 'Utility', 'Healthcare', 'Space']
};
