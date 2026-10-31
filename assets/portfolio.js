/*
 * Portfolio allocation — public-safe view of the actual holdings.
 *
 * DELIBERATELY EXCLUDED (never add these here):
 *   - share counts
 *   - absolute dollar amounts / cost basis / total portfolio value
 *   - broker, tax or account details
 *   - personal decision rules, valuation targets and watchlist rationale
 *   - the name or location of the private source document
 *
 * What is here is allocation *weights* (ratios, no absolute size) plus a
 * one-line role per holding, alongside live market data fetched at runtime.
 *
 * The model validates this file at load time (see assets/portfolio-model.js):
 * only the keys listed in ALLOWED_KEYS are permitted, so a sensitive field
 * fails loudly instead of being published.
 *
 * Allocation weights: total 100%.
 */
window.PORTFOLIO = {
  // Holdings, ordered by allocation weight (descending).
  holdings: [
    { symbol: 'MSFT', role: 'Mega-cap software & cloud', sector: 'Tech', group: 'tech', weight: 100 }
  ],

  // Sector buckets for the concentration strip. Only sectors that actually
  // appear above need to be listed.
  sectorOrder: ['Tech']
};
