#!/usr/bin/env node
/*
 * Writes data/snapshot.json — the offline fallback the page shows when every
 * live feed fails. Run by the refresh workflow, and manually via:
 *
 *   node scripts/make-snapshot.js
 *
 * Uses the same Yahoo spark endpoint the browser uses, chunked to respect
 * Yahoo's 20-symbol-per-request limit.
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const SPARK = 'https://query1.finance.yahoo.com/v7/finance/spark';
const CHUNK_SIZE = 20;
const SPARK_POINTS = 78;   // one trading day of 5-minute bars

const SYMBOLS = [
  '^GSPC', '^IXIC', '^DJI', '^RUT', '^VIX',
  '^HSI', '^HSCE', '^N225', '^STOXX50E', '^FTSE', '^TNX',
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO',
  'AMD', 'NFLX', 'CRM', 'PLTR', 'JPM', 'XOM',
  'BTC-USD', 'ETH-USD', 'SOL-USD',
  'EURUSD=X', 'GBPUSD=X', 'JPY=X'
];

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

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

async function main() {
  const groups = chunk(SYMBOLS, CHUNK_SIZE);
  const quotes = {};

  for (const group of groups) {
    const url = SPARK + '?symbols=' + encodeURIComponent(group.join(',')) + '&range=1d&interval=5m';
    let payload;
    try {
      payload = JSON.parse(await get(url));
    } catch (err) {
      console.error('chunk failed (' + group.length + ' symbols):', err.message);
      continue;
    }
    const results = (payload.spark && payload.spark.result) || [];
    for (const entry of results) {
      const resp = entry.response && entry.response[0];
      if (!resp || !resp.meta) continue;
      const m = resp.meta;
      const price = num(m.regularMarketPrice);
      const prev = num(m.chartPreviousClose !== undefined && m.chartPreviousClose !== null
        ? m.chartPreviousClose : m.previousClose);
      const change = (price !== null && prev !== null) ? price - prev : null;
      const changePct = (change !== null && prev) ? (change / prev) * 100 : null;

      // Keep the intraday close series so the page can still draw sparklines
      // when it falls back to the snapshot. Trimmed to one trading day of
      // 5-minute bars (78 points) to keep the file small.
      const rawCloses = (resp.indicators && resp.indicators.quote &&
        resp.indicators.quote[0] && resp.indicators.quote[0].close) || [];
      const closes = rawCloses
        .filter((c) => typeof c === 'number' && isFinite(c))
        .slice(-SPARK_POINTS);

      quotes[entry.symbol] = {
        symbol: entry.symbol,
        name: m.shortName || m.longName || entry.symbol,
        price: price,
        prevClose: prev,
        change: change,
        changePct: changePct,
        dayHigh: num(m.regularMarketDayHigh),
        dayLow: num(m.regularMarketDayLow),
        high52: num(m.fiftyTwoWeekHigh),
        low52: num(m.fiftyTwoWeekLow),
        volume: num(m.regularMarketVolume),
        currency: m.currency || null,
        timezone: m.exchangeTimezoneName || null,
        gmtoffset: num(m.gmtoffset),
        marketTime: num(m.regularMarketTime),
        closes: closes
      };
    }
    // be polite to Yahoo between chunks
    await new Promise((r) => setTimeout(r, 1500));
  }

  const count = Object.keys(quotes).length;
  if (count === 0) {
    console.error('No quotes retrieved — refusing to overwrite an existing snapshot.');
    process.exit(1);
  }

  const snapshot = {
    updated: new Date().toISOString(),
    count: count,
    quotes: quotes
  };

  const outPath = path.join(__dirname, '..', 'data', 'snapshot.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n');
  console.log('Wrote ' + outPath + ' with ' + count + ' quotes at ' + snapshot.updated);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
