/*
 * Writes data/fundamentals.json — the offline fallback for the financial
 * information shown under the chart.
 *
 * Run by the refresh workflow, and manually via:
 *
 *   node scripts/make-fundamentals.js
 *
 * Only equities have financial statements. An index, an FX pair and a
 * crypto coin return nothing, so they are simply not in the output — the
 * page then shows no fundamentals panel for them, which is correct.
 *
 * The currency of each entry is recorded alongside the figures, because
 * the price and the statements are not always in the same currency (a
 * Hong Kong stock's statements are in CNY and its price is in HKD).
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const universe = require('../assets/universe.js');
const fundamentals = require('../assets/fundamentals-model.js');

const TIMESERIES =
  'https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries';

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(new Error('timeout')); });
  });
}

async function main() {
  const equities = universe.ofGroup('equity');
  const types = fundamentals.requestTypes().join(',');
  const out = {};

  for (const eq of equities) {
    const url = TIMESERIES + '/' + encodeURIComponent(eq.symbol) +
      '?symbol=' + encodeURIComponent(eq.symbol) + '&type=' + types +
      '&period1=1400000000&period2=1900000000';
    try {
      const payload = JSON.parse(await get(url));
      const parsed = fundamentals.parse(payload, eq.symbol);
      if (!parsed) {
        console.log(eq.symbol + ': no statements (skipped)');
        continue;
      }
      out[eq.symbol] = {
        symbol: parsed.symbol,
        currency: parsed.currency,
        asOf: parsed.asOf,
        ttm: parsed.ttm,
        annual: parsed.annual,
        quarterly: parsed.quarterly
      };
      console.log(eq.symbol + ': ' + parsed.currency + ' to ' + parsed.asOf);
    } catch (err) {
      console.error(eq.symbol + ' failed:', err.message);
    }
    // be polite to Yahoo between requests
    await new Promise((r) => setTimeout(r, 600));
  }

  const count = Object.keys(out).length;
  if (count === 0) {
    console.error('No fundamentals retrieved — refusing to overwrite an existing file.');
    process.exit(1);
  }

  const outPath = path.join(__dirname, '..', 'data', 'fundamentals.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    updated: new Date().toISOString(),
    count: count,
    fundamentals: out
  }, null, 2) + '\n');

  console.log('Wrote ' + outPath + ' with ' + count + ' entries');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
