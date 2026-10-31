/*
 * Portfolio — public-safe view of the actual holdings.
 *
 * DELIBERATELY EXCLUDED (never add these here):
 *   - share counts
 *   - absolute dollar amounts / cost basis / total portfolio value
 *   - broker, tax or account details
 *   - personal decision rules, valuation targets and watchlist rationale
 *   - the name or location of the private source document
 *
 * What is here is the ticker symbol, a one-line role and a sector bucket,
 * alongside live market data fetched at runtime.
 *
 * NOTE ON ALLOCATION WEIGHTS: there is deliberately NO `weight` field.
 * The position size is known privately, but the allocation *percentage*
 * is not published — and a share count is not an allocation weight.
 * Publishing "100%" here would claim this position is the whole portfolio,
 * which is not established. The model treats the weight as optional, and
 * the UI renders the exposure figures as "—" when it is absent.
 *
 * If the true allocation ever becomes publishable, add a `weight` to every
 * holding (the model requires all-or-nothing) and the exposure figures and
 * sector strip will appear automatically.
 *
 * The model validates this file at load time (see assets/portfolio-model.js):
 * only the keys listed in ALLOWED_KEYS are permitted, so a sensitive field
 * fails loudly instead of being published.
 */
window.PORTFOLIO = {
  // Holdings.
  holdings: [
    { symbol: 'MSFT', role: 'Mega-cap software & cloud', sector: 'Tech', group: 'tech' }
  ],

  // Sector buckets for the concentration strip. Only used when the
  // holdings carry allocation weights.
  sectorOrder: ['Tech']
};
