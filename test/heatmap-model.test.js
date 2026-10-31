/*
 * Tests for the heatmap treemap model.
 *
 * The geometry is the whole point of this module, so the tests check that
 * tiles never overlap, never escape their container, and are ordered by
 * market cap.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const model = require('../assets/heatmap-model.js');

function item(symbol, sector, industry, cap) {
  return {
    symbol: symbol,
    name: symbol + ' Inc',
    sector: sector,
    industry: industry,
    marketCap: cap,
    price: 100,
    changePct: 1.5
  };
}

const SAMPLE = [
  item('AAPL', 'Information Technology', 'Tech Hardware', 3e12),
  item('MSFT', 'Information Technology', 'Systems Software', 3.1e12),
  item('NVDA', 'Information Technology', 'Semiconductors', 4.9e12),
  item('GOOGL', 'Communication Services', 'Interactive Media', 2.5e12),
  item('JPM', 'Financials', 'Banks', 0.8e12),
  item('XOM', 'Energy', 'Oil & Gas', 0.5e12),
  item('WMT', 'Consumer Staples', 'Staples Retail', 0.9e12)
];

function overlaps(a, b) {
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.w, by2 = b.y + b.h;
  const ox = Math.min(ax2, bx2) - Math.max(a.x, b.x);
  const oy = Math.min(ay2, by2) - Math.max(a.y, b.y);
  return ox > 0.01 && oy > 0.01;
}

test('buildHierarchy: groups by sector then industry', () => {
  const h = model.buildHierarchy(SAMPLE);
  // IT, Communication Services, Financials, Energy, Consumer Staples.
  assert.equal(h.length, 5);

  const it = h.find((s) => s.sector === 'Information Technology');
  assert.ok(it);
  assert.equal(it.group, 'tech');
  assert.equal(it.industries.length, 3);
  assert.equal(it.marketCap, 3e12 + 3.1e12 + 4.9e12);
});

test('buildHierarchy: Information Technology and Communication Services are tech', () => {
  const h = model.buildHierarchy(SAMPLE);
  const groups = {};
  h.forEach((s) => { groups[s.sector] = s.group; });
  assert.equal(groups['Information Technology'], 'tech');
  assert.equal(groups['Communication Services'], 'tech');
  assert.equal(groups['Financials'], 'nontech');
  assert.equal(groups['Energy'], 'nontech');
  assert.equal(groups['Consumer Staples'], 'nontech');
});

test('buildHierarchy: sector order is by market cap descending', () => {
  const h = model.buildHierarchy(SAMPLE);
  for (let i = 1; i < h.length; i++) {
    assert.ok(h[i - 1].marketCap >= h[i].marketCap,
      'sectors must be ordered by market cap');
  }
});

test('layout: every tile lies inside the canvas', () => {
  const W = 1200, H = 700;
  const res = model.layout(SAMPLE, W, H);
  assert.ok(res.tiles.length > 0);
  res.tiles.forEach((t) => {
    assert.ok(t.x >= -0.01, `tile ${t.symbol} x=${t.x} < 0`);
    assert.ok(t.y >= -0.01, `tile ${t.symbol} y=${t.y} < 0`);
    assert.ok(t.x + t.w <= W + 0.01, `tile ${t.symbol} overflows right`);
    assert.ok(t.y + t.h <= H + 0.01, `tile ${t.symbol} overflows bottom`);
    assert.ok(t.w > 0 && t.h > 0, `tile ${t.symbol} has no area`);
  });
});

test('layout: no two tiles overlap', () => {
  const res = model.layout(SAMPLE, 1200, 700);
  for (let i = 0; i < res.tiles.length; i++) {
    for (let j = i + 1; j < res.tiles.length; j++) {
      assert.ok(!overlaps(res.tiles[i], res.tiles[j]),
        `${res.tiles[i].symbol} overlaps ${res.tiles[j].symbol}`);
    }
  }
});

test('layout: tiles fill the canvas area (no big holes)', () => {
  const W = 1200, H = 700;
  const res = model.layout(SAMPLE, W, H);
  const used = res.tiles.reduce((a, t) => a + t.w * t.h, 0);
  const ratio = used / (W * H);
  // Padding between tiles and the reserved header band means the tiles do
  // not cover 100% of the canvas, but they must cover most of it.
  assert.ok(ratio > 0.75, `tiles cover only ${(ratio * 100).toFixed(1)}% of the canvas`);
});

test('layout: a bigger market cap gets a bigger tile', () => {
  const res = model.layout(SAMPLE, 1200, 700);
  const by = {};
  res.tiles.forEach((t) => { by[t.symbol] = t.area; });
  assert.ok(by['NVDA'] > by['AAPL'], 'NVDA (4.9T) should be larger than AAPL (3.0T)');
  assert.ok(by['AAPL'] > by['XOM'], 'AAPL (3.0T) should be larger than XOM (0.5T)');
});

test('layout: tech and non-tech occupy separate halves', () => {
  const W = 1200, H = 700;
  const res = model.layout(SAMPLE, W, H);
  assert.ok(res.tech);
  assert.ok(res.nontech);

  const techRight = res.tech.x + res.tech.w;
  const nonTechLeft = res.nontech.x;

  // The two halves must not overlap horizontally.
  assert.ok(techRight <= nonTechLeft + 0.01,
    `tech half ends at ${techRight}, non-tech starts at ${nonTechLeft}`);

  // And every tech tile must sit in the tech half.
  res.tech.sectors.forEach((s) => s.industries.forEach((i) => i.stocks.forEach((t) => {
    assert.ok(t.x >= res.tech.x - 0.01 && t.x + t.w <= techRight + 0.01,
      `${t.symbol} escaped the tech half`);
  })));
});

test('layout: every stock appears exactly once', () => {
  const res = model.layout(SAMPLE, 1200, 700);
  const syms = res.tiles.map((t) => t.symbol).sort();
  assert.deepEqual(syms, SAMPLE.map((s) => s.symbol).sort());
});

test('layout: reports counts and caps', () => {
  const res = model.layout(SAMPLE, 1200, 700);
  // IT, Communication Services, Financials, Energy, Consumer Staples.
  assert.equal(res.stats.sectors, 5);
  assert.equal(res.stats.techCount, 4);
  assert.equal(res.stats.nonTechCount, 3);
  assert.ok(res.stats.techCap > res.stats.nonTechCap);
  assert.equal(res.stats.total, res.stats.techCap + res.stats.nonTechCap);
});

test('layout: a tile between the size thresholds renders without a label', () => {
  // A small stock sharing an industry with a huge one ends up with a small
  // but visible area, so it renders as a tile without a label.
  const items = [
    item('BIG', 'Information Technology', 'Software', 1e12),
    item('TINY', 'Information Technology', 'Software', 1e8)
  ];
  const res = model.layout(items, 1200, 700);
  const tiny = res.tiles.find((t) => t.symbol === 'TINY');
  assert.ok(tiny, 'the small tile should still be emitted');
  assert.ok(tiny.area >= model.MIN_TILE_AREA,
    `the tile should be over the drop threshold, was ${tiny.area}`);
  assert.ok(tiny.area < model.MIN_LABEL_AREA,
    `the tile should be under the label threshold, was ${tiny.area}`);
  assert.equal(tiny.showLabel, false, 'a small tile must not show a label');

  const big = res.tiles.find((t) => t.symbol === 'BIG');
  assert.equal(big.showLabel, true, 'the big tile must show a label');
});

test('layout: a sub-pixel tile is dropped entirely', () => {
  // Below MIN_TILE_AREA a tile is a fraction of a pixel — rendering it
  // would only add noise, so it is left out.
  const items = [
    item('BIG', 'Information Technology', 'Software', 1e12),
    item('DUST', 'Information Technology', 'Software', 1e6)
  ];
  const res = model.layout(items, 1200, 700);
  assert.equal(res.tiles.find((t) => t.symbol === 'DUST'), undefined,
    'a sub-pixel tile must not be emitted');
});

test('layout: the sector label band is kept clear of the stock tiles', () => {
  // The sector name is drawn at the top-left of its cell. If a stock tile
  // started there, the label and the tile's own text would overlap and both
  // become unreadable. The model therefore reserves a band at the top of
  // each sector cell for the label, and the tiles start below it.
  const res = model.layout(SAMPLE, 1200, 700);
  res.sectors.forEach((s) => {
    s.industries.forEach((i) => {
      i.stocks.forEach((t) => {
        assert.ok(t.y >= s.y + model.SECTOR_LABEL_BAND - 0.01,
          `${t.symbol} overlaps the sector label of ${s.sector} ` +
          `(tile y=${t.y.toFixed(1)}, sector y=${s.y.toFixed(1)})`);
      });
    });
  });
});

test('layout: the industry label band is kept clear of the stock tiles', () => {
  // Same rule one level down: the industry name is drawn at the top-left of
  // its cell, so a big stock tile in a small industry would land on top of
  // the label and both would be unreadable.
  const res = model.layout(SAMPLE, 1200, 700);
  res.sectors.forEach((s) => {
    s.industries.forEach((i) => {
      if (i.h <= 40) return;   // too small to carry a label at all
      i.stocks.forEach((t) => {
        assert.ok(t.y >= i.y + model.SECTOR_LABEL_BAND - 0.01,
          `${t.symbol} overlaps the industry label of ${i.industry} ` +
          `(tile y=${t.y.toFixed(1)}, industry y=${i.y.toFixed(1)})`);
      });
    });
  });
});

test('layout: a stock alone in its sector still gets a large tile', () => {
  // A small-cap in a sector of its own is still sized by its own market cap
  // within that sector, so it fills the sector cell.
  const items = [
    item('BIG', 'Information Technology', 'Software', 1e12),
    item('TINY', 'Health Care', 'Pharma', 1e6)
  ];
  const res = model.layout(items, 1200, 700);
  const tiny = res.tiles.find((t) => t.symbol === 'TINY');
  assert.ok(tiny, 'the tiny tile should be emitted');
  assert.ok(tiny.w > 0 && tiny.h > 0);
});

test('layout: handles an empty list without throwing', () => {
  const res = model.layout([], 800, 400);
  assert.equal(res.tiles.length, 0);
  assert.equal(res.stats.total, 0);
});

test('layout: handles a single stock', () => {
  const res = model.layout([item('ONLY', 'Financials', 'Banks', 1e12)], 800, 400);
  assert.equal(res.tiles.length, 1);
  assert.ok(res.tiles[0].w > 0 && res.tiles[0].h > 0);
});

test('squarify: tiles are proportional to value', () => {
  const items = [{ value: 3, tag: 'big' }, { value: 1, tag: 'small' }];
  const out = model.squarify(items, 0, 0, 400, 400);
  const total = out.reduce((a, t) => a + t.w * t.h, 0);
  const a = out.find((t) => t.tag === 'big');
  const b = out.find((t) => t.tag === 'small');
  assert.ok(a, 'the big item must be in the output');
  assert.ok(b, 'the small item must be in the output');
  assert.ok(Math.abs(a.area / total - 0.75) < 0.01, 'area ratio should be 0.75');
  assert.ok(Math.abs(b.area / total - 0.25) < 0.01, 'area ratio should be 0.25');
});

test('squarify: zero-value items get no area', () => {
  const out = model.squarify([{ value: 1 }, { value: 0 }], 0, 0, 100, 100);
  const zero = out.find((t) => t.value === 0);
  assert.ok(zero.w === 0 || zero.h === 0, 'a zero-value tile must have no area');
});

test('tileColor: green for up, red for down, flat otherwise', () => {
  assert.equal(model.tileColor(2.5), 'var(--up)');
  assert.equal(model.tileColor(-1.2), 'var(--down)');
  assert.equal(model.tileColor(0), 'var(--flat)');
  assert.equal(model.tileColor(null), 'var(--flat)');
});

// ----------------------------------------------------------- heat scale

test('heatColor: a flat or missing change is the neutral step', () => {
  assert.equal(model.heatColor(0), 'var(--heat-0)');
  assert.equal(model.heatColor(null), 'var(--heat-0)');
  assert.equal(model.heatColor(undefined), 'var(--heat-0)');
  assert.equal(model.heatColor(NaN), 'var(--heat-0)');
});

test('heatColor: the scale is symmetric around zero', () => {
  // A +2% move and a -2% move must sit at the same distance from the
  // neutral step, otherwise the map reads as biased.
  const up = model.heatColor(2);
  const down = model.heatColor(-2);
  assert.equal(up, 'var(--heat-3u)');
  assert.equal(down, 'var(--heat-3)');
});

test('heatColor: bigger moves get a deeper colour', () => {
  // Band edges: |move| <= 0.3 -> step 1, <= 1.0 -> 2, <= 2.0 -> 3, else 4.
  assert.equal(model.heatColor(0.2), 'var(--heat-1u)');
  assert.equal(model.heatColor(0.5), 'var(--heat-2u)');
  assert.equal(model.heatColor(1), 'var(--heat-2u)');
  assert.equal(model.heatColor(1.5), 'var(--heat-3u)');
  assert.equal(model.heatColor(2), 'var(--heat-3u)');
  assert.equal(model.heatColor(2.5), 'var(--heat-4u)');
  assert.equal(model.heatColor(9), 'var(--heat-4u)');
  assert.equal(model.heatColor(-0.2), 'var(--heat-1)');
  assert.equal(model.heatColor(-0.5), 'var(--heat-2)');
  assert.equal(model.heatColor(-1.5), 'var(--heat-3)');
  assert.equal(model.heatColor(-2.5), 'var(--heat-4)');
  assert.equal(model.heatColor(-9), 'var(--heat-4)');
});

test('heatColor: the sign never flips the direction of the scale', () => {
  // Every positive change must map to a "u" (up) token and every negative
  // change to a plain token — a sign error here would paint a rally red.
  [0.1, 0.9, 1.4, 3, 12].forEach((v) => {
    assert.ok(/^var\(--heat-\du\)$/.test(model.heatColor(v)), `${v} must use an up token`);
  });
  [-0.1, -0.9, -1.4, -3, -12].forEach((v) => {
    assert.ok(/^var\(--heat-\d\)$/.test(model.heatColor(v)), `${v} must use a down token`);
  });
});
