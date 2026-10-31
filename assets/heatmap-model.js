/*
 * Heatmap model — pure layout logic for the S&P 500 treemap.
 *
 * Separated from the browser so the geometry can be unit tested: a treemap
 * that silently overlaps or overflows its container is the kind of bug that
 * is invisible in a unit test but obvious on screen.
 *
 * The layout is a slice-and-dice squarified treemap:
 *   1. group stocks by sector (the "tile" level)
 *   2. within a sector, group by sub-industry (the inner level)
 *   3. size every cell by market cap
 *
 * Browser + Node share this file, exactly like portfolio-model.js.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HeatmapModel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * The two top-level buckets the treemap is split into.
   *
   * "Tech" covers Information Technology and Communication Services — the
   * GICS sectors that are genuinely software/platform businesses. The rest
   * of GICS is "Non-tech". This mirrors the portfolio panel's split.
   */
  var TECH_SECTORS = ['Information Technology', 'Communication Services'];

  /**
   * A stock tile that is too small to show a label is still rendered (so
   * the treemap has no holes), but without text. This is the size in square
   * pixels below which a tile drops its label.
   */
  var MIN_LABEL_AREA = 900;

  /**
   * Treemap cells smaller than this (px²) are not emitted at all. Below this
   * a tile is a few pixels across and cannot be seen or clicked.
   */
  var MIN_TILE_AREA = 24;

  /**
   * The band at the top of each sector cell reserved for the sector name.
   *
   * The name is drawn at the top-left of the cell, which is exactly where the
   * largest stock tile starts. Without a reserved band the two overlap and
   * both become unreadable, so the stock tiles are laid out below it.
   */
  var SECTOR_LABEL_BAND = 15;

  function isTech(sector) {
    return TECH_SECTORS.indexOf(sector) !== -1;
  }

  /**
   * Group items into sectors, then industries.
   *
   * @param {Array} items  [{ symbol, sector, industry, marketCap, ... }]
   * @returns {Array} [{ sector, group, marketCap, industries: [{ industry, marketCap, items }] }]
   */
  function buildHierarchy(items) {
    var bySector = {};

    items.forEach(function (it) {
      if (!it || !it.sector || !it.industry) return;
      var cap = typeof it.marketCap === 'number' && isFinite(it.marketCap) && it.marketCap > 0
        ? it.marketCap : 0;
      var s = bySector[it.sector];
      if (!s) {
        s = bySector[it.sector] = {
          sector: it.sector,
          group: isTech(it.sector) ? 'tech' : 'nontech',
          marketCap: 0,
          industries: {}
        };
      }
      var ind = s.industries[it.industry];
      if (!ind) {
        ind = s.industries[it.industry] = {
          industry: it.industry,
          marketCap: 0,
          items: []
        };
      }
      ind.items.push(it);
      ind.marketCap += cap;
      s.marketCap += cap;
    });

    return Object.keys(bySector).map(function (key) {
      var s = bySector[key];
      var industries = Object.keys(s.industries).map(function (k) {
        var ind = s.industries[k];
        ind.items.sort(function (a, b) {
          var ac = a.marketCap || 0, bc = b.marketCap || 0;
          if (bc !== ac) return bc - ac;
          return String(a.symbol).localeCompare(String(b.symbol));
        });
        return ind;
      });
      industries.sort(function (a, b) {
        if (b.marketCap !== a.marketCap) return b.marketCap - a.marketCap;
        return a.industry.localeCompare(b.industry);
      });
      s.industries = industries;
      return s;
    }).sort(function (a, b) {
      if (b.marketCap !== a.marketCap) return b.marketCap - a.marketCap;
      return a.sector.localeCompare(b.sector);
    });
  }

  /**
   * Squarified treemap over a rectangle.
   *
   * Implements the standard squarify algorithm: lay out items in rows along
   * the shorter side of the remaining space, choosing each row's membership
   * so the resulting rectangles stay as close to square as possible.
   *
   * @param {Array} items   [{ value }]
   * @param {number} x      left
   * @param {number} y      top
   * @param {number} w      width
   * @param {number} h      height
   * @returns {Array} items with .x .y .w .h set
   */
  function squarify(items, x, y, w, h) {
    var out = [];
    var total = items.reduce(function (a, it) { return a + (it.value || 0); }, 0);
    if (!total || w <= 0 || h <= 0) {
      return items.map(function (it) {
        out.push(Object.assign({}, it, { x: x, y: y, w: 0, h: 0, area: 0 }));
        return out[out.length - 1];
      });
    }

    var scale = (w * h) / total;
    var scaled = items.map(function (it) {
      return { orig: it, value: (it.value || 0) * scale };
    });

    var rest = scaled.slice();
    var cx = x, cy = y, cw = w, ch = h;

    while (rest.length) {
      // The row is laid along the SHORT side of the space that is left, so
      // that the tiles it contains come out as close to square as possible.
      var shortSide = Math.min(cw, ch);
      if (shortSide <= 0) break;

      var row = [];
      var rowValue = 0;

      // Grow the row while it does not worsen the aspect ratio.
      while (rest.length) {
        var candidate = rest[0];
        var nextValue = rowValue + candidate.value;
        var best = worstRatio(row, rowValue, shortSide);
        var nextBest = worstRatio(row.concat([candidate]), nextValue, shortSide);
        if (row.length && nextBest > best) break;
        row.push(rest.shift());
        rowValue = nextValue;
      }

      if (!rowValue) {
        // Only zero-value items are left; they get no area.
        rest.forEach(function (it) { it.rect = { x: cx, y: cy, w: 0, h: 0 }; });
        break;
      }

      // Row length is the short side, so the thickness follows from the area.
      var thickness = rowValue / shortSide;

      if (cw >= ch) {
        // The space is wider than tall: the row is a vertical strip of full
        // height, and its tiles are stacked up that strip.
        var ry = cy;
        row.forEach(function (it) {
          var len = it.value / thickness;
          it.rect = { x: cx, y: ry, w: thickness, h: len };
          ry += len;
        });
        cx += thickness;
        cw -= thickness;
      } else {
        // The space is taller than wide: the row is a horizontal band of
        // full width, and its tiles sit side by side along it.
        var rx = cx;
        row.forEach(function (it) {
          var len = it.value / thickness;
          it.rect = { x: rx, y: cy, w: len, h: thickness };
          rx += len;
        });
        cy += thickness;
        ch -= thickness;
      }
    }

    scaled.forEach(function (it) {
      var r = it.rect || { x: x, y: y, w: 0, h: 0 };
      // Merge the rectangle onto the ORIGINAL item so the caller's fields
      // (symbol, sector, ...) survive alongside the geometry.
      out.push(Object.assign({}, it.orig, {
        x: r.x, y: r.y, w: r.w, h: r.h,
        area: r.w * r.h
      }));
    });

    return out;
  }

  /**
   * The worst (largest) aspect ratio in a candidate row.
   */
  function worstRatio(row, rowValue, shortSide) {
    if (!row.length || rowValue <= 0 || shortSide <= 0) return Infinity;
    var max = rowValue, min = rowValue;
    row.forEach(function (it) {
      if (it.value > max) max = it.value;
      if (it.value < min) min = it.value;
    });
    var s2 = rowValue * rowValue;
    var w2 = shortSide * shortSide;
    return Math.max((w2 * max) / s2, s2 / (w2 * min));
  }

  /**
   * Lay out the full three-level treemap.
   *
   * @param {Array}  items
   * @param {number} width
   * @param {number} height
   * @returns {Object} { tech, nontech, sectors, stats }
   */
  function layout(items, width, height) {
    var hierarchy = buildHierarchy(items);

    // Split the canvas between tech and non-tech by their total market cap,
    // then lay each half out on its own.
    var techCap = 0, nonTechCap = 0;
    hierarchy.forEach(function (s) {
      if (s.group === 'tech') techCap += s.marketCap;
      else nonTechCap += s.marketCap;
    });
    var total = techCap + nonTechCap;

    var groups = {
      tech: { group: 'tech', marketCap: techCap, sectors: [] },
      nontech: { group: 'nontech', marketCap: nonTechCap, sectors: [] }
    };
    hierarchy.forEach(function (s) { groups[s.group].sectors.push(s); });

    var result = { tech: null, nontech: null, sectors: [], stats: {} };

    // The two halves sit side by side. A minimum width keeps a small group
    // from collapsing to a sliver.
    var MIN_GROUP_FRACTION = 0.18;
    var techFrac = total > 0 ? techCap / total : 0.5;
    techFrac = Math.max(MIN_GROUP_FRACTION, Math.min(1 - MIN_GROUP_FRACTION, techFrac));

    var halves = [
      { key: 'tech', x: 0, w: width * techFrac },
      { key: 'nontech', x: width * techFrac, w: width * (1 - techFrac) }
    ];

    halves.forEach(function (half) {
      var g = groups[half.key];
      if (!g.sectors.length) {
        result[half.key] = { x: half.x, y: 0, w: half.w, h: height, marketCap: 0, sectors: [] };
        return;
      }
      // Reserve a header band for the group label.
      var HEADER = 22;
      var bodyH = Math.max(1, height - HEADER);
      var laid = squarify(
        g.sectors.map(function (s) { return { value: s.marketCap, sectorRef: s }; }),
        half.x, HEADER, half.w, bodyH
      );

      var groupRect = { x: half.x, y: 0, w: half.w, h: height, marketCap: g.marketCap, sectors: [] };
      laid.forEach(function (cell) {
        var s = cell.sectorRef;
        // Pad each sector cell so the gutters read as separate tiles.
        var PAD = 3;
        var sx = cell.x + PAD, sy = cell.y + PAD;
        var sw = Math.max(0, cell.w - PAD * 2), sh = Math.max(0, cell.h - PAD * 2);
        if (sw <= 0 || sh <= 0) return;

        // Reserve the top band for the sector name so the biggest stock tile
        // cannot sit underneath the label.
        var labelBand = Math.min(SECTOR_LABEL_BAND, sh);
        var bodyY = sy + labelBand;
        var bodyH = Math.max(0, sh - labelBand);

        var industryCells = squarify(
          s.industries.map(function (ind) { return { value: ind.marketCap, industryRef: ind }; }),
          sx, bodyY, sw, bodyH
        );
        var sectorOut = {
          sector: s.sector,
          group: s.group,
          marketCap: s.marketCap,
          x: sx, y: sy, w: sw, h: sh,
          industries: []
        };

        industryCells.forEach(function (icell) {
          var ind = icell.industryRef;
          var ipad = 2;
          var ix = icell.x + ipad, iy = icell.y + ipad;
          var iw = Math.max(0, icell.w - ipad * 2), ih = Math.max(0, icell.h - ipad * 2);
          if (iw <= 0 || ih <= 0) return;

          // The industry name is drawn at the top-left of its cell, so the
          // stock tiles get their own band to sit in — otherwise the largest
          // tile in the industry lands underneath the label.
          var indBand = ih > 40 ? Math.min(SECTOR_LABEL_BAND, ih) : 0;
          var stockY = iy + indBand;
          var stockH = Math.max(0, ih - indBand);

          var stockCells = squarify(
            ind.items.map(function (it) { return { value: it.marketCap || 0, stockRef: it }; }),
            ix, stockY, iw, stockH
          );

          var industryOut = {
            industry: ind.industry,
            marketCap: ind.marketCap,
            x: ix, y: iy, w: iw, h: ih,
            stocks: []
          };

          stockCells.forEach(function (scell) {
            var area = scell.w * scell.h;
            if (area < MIN_TILE_AREA) return;
            var it = scell.stockRef;
            industryOut.stocks.push({
              symbol: it.symbol,
              name: it.name,
              sector: it.sector,
              industry: it.industry,
              price: it.price,
              changePct: it.changePct,
              marketCap: it.marketCap,
              x: scell.x, y: scell.y, w: scell.w, h: scell.h,
              area: area,
              showLabel: area >= MIN_LABEL_AREA
            });
          });

          if (industryOut.stocks.length) {
            sectorOut.industries.push(industryOut);
          }
        });

        // The sector is registered once, after its industries are filled in.
        if (sectorOut.industries.length) {
          groupRect.sectors.push(sectorOut);
          result.sectors.push(sectorOut);
        }
      });

      result[half.key] = groupRect;
    });

    // Every stock tile in the output, flattened — handy for tests.
    result.tiles = [];
    result.sectors.forEach(function (s) {
      s.industries.forEach(function (i) {
        i.stocks.forEach(function (t) { result.tiles.push(t); });
      });
    });

    result.stats = {
      total: total,
      techCap: techCap,
      nonTechCap: nonTechCap,
      techCount: countStocks(result.tech),
      nonTechCount: countStocks(result.nontech),
      sectors: hierarchy.length,
      industries: hierarchy.reduce(function (a, s) { return a + s.industries.length; }, 0)
    };

    return result;
  }

  function countStocks(groupRect) {
    if (!groupRect) return 0;
    return groupRect.sectors.reduce(function (a, s) {
      return a + s.industries.reduce(function (b, i) { return b + i.stocks.length; }, 0);
    }, 0);
  }

  /**
   * The colour for a tile: green for up, red for down, muted for flat.
   * Returns a CSS background value.
   */
  function tileColor(changePct) {
    if (changePct === null || changePct === undefined || !isFinite(changePct)) {
      return 'var(--flat)';
    }
    if (changePct > 0) return 'var(--up)';
    if (changePct < 0) return 'var(--down)';
    return 'var(--flat)';
  }

  /**
   * The diverging heat scale: four steps each way from a neutral middle.
   *
   * The step boundaries are symmetric, so a +2% move and a -2% move get the
   * same depth of colour and the map cannot read as biased toward one side.
   * The band edges are half-open so a value lands in exactly one step.
   */
  var HEAT_STEPS = [
    { max: 0.3, token: '1' },
    { max: 1.0, token: '2' },
    { max: 2.0, token: '3' },
    { max: Infinity, token: '4' }
  ];

  /**
   * Map a percentage change to a heat-scale CSS custom property.
   *
   * @param {number|null} changePct
   * @returns {string} e.g. "var(--heat-3u)"
   */
  function heatColor(changePct) {
    if (changePct === null || changePct === undefined || !isFinite(changePct)) {
      return 'var(--heat-0)';
    }
    var mag = Math.abs(changePct);
    if (mag === 0) return 'var(--heat-0)';

    var token = HEAT_STEPS[HEAT_STEPS.length - 1].token;
    for (var i = 0; i < HEAT_STEPS.length; i++) {
      if (mag <= HEAT_STEPS[i].max) {
        token = HEAT_STEPS[i].token;
        break;
      }
    }
    // The "u" (up) tokens are the green side; the plain ones are the red side.
    return changePct > 0 ? 'var(--heat-' + token + 'u)' : 'var(--heat-' + token + ')';
  }

  /**
   * Pick readable text colour for a tile background.
   */
  function tileTextColor(changePct) {
    if (changePct === null || changePct === undefined || !isFinite(changePct)) {
      return 'var(--text-3)';
    }
    return 'var(--text)';
  }

  return {
    TECH_SECTORS: TECH_SECTORS,
    MIN_LABEL_AREA: MIN_LABEL_AREA,
    MIN_TILE_AREA: MIN_TILE_AREA,
    SECTOR_LABEL_BAND: SECTOR_LABEL_BAND,
    isTech: isTech,
    buildHierarchy: buildHierarchy,
    squarify: squarify,
    layout: layout,
    tileColor: tileColor,
    heatColor: heatColor,
    tileTextColor: tileTextColor
  };
});
