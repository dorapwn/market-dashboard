"""Probe the market heatmap: the tile count, the hierarchy, and that no
tile overlaps another or leaves the canvas.

Usage:
    export PLAYWRIGHT_BROWSERS_PATH=/opt/data/.toolchain/pw-browsers
    /opt/data/.toolchain/browser-venv/bin/python test/browser/heatmap_probe.py [url]
"""
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"

results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))


with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1600, "height": 1000})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))

    pg.goto(URL, wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(14000)

    # The heatmap lives behind its own tab now.
    pg.click('.tab-bar .tab[data-tab="heatmap"]')
    pg.wait_for_timeout(4000)

    # --- the treemap rendered -------------------------------------------
    info = pg.evaluate("""
      () => {
        const c = document.getElementById('heatmapCanvas');
        const tiles = [...c.querySelectorAll('.hm-tile')];
        const sectors = [...c.querySelectorAll('.hm-sector')];
        const industries = [...c.querySelectorAll('.hm-industry')];
        return {
          tiles: tiles.length,
          sectors: sectors.length,
          industries: industries.length,
          canvasW: c.clientWidth,
          canvasH: c.clientHeight,
          topGroups: [...c.querySelectorAll('.hm-group')].map(g => g.dataset.group || g.textContent.trim())
        };
      }
    """)
    check("the treemap rendered tiles", info["tiles"] > 400, f"{info['tiles']} tiles")
    check("the treemap rendered sectors", info["sectors"] > 5, str(info["sectors"]))
    check("the treemap rendered industries", info["industries"] > 50, str(info["industries"]))
    check("the canvas has a real size", info["canvasW"] > 400 and info["canvasH"] > 200,
          f"{info['canvasW']}x{info['canvasH']}")

    # --- no two tiles overlap -------------------------------------------
    overlap = pg.evaluate("""
      () => {
        const tiles = [...document.querySelectorAll('#heatmapCanvas .hm-tile')];
        let worst = 0, pairs = 0;
        for (let i = 0; i < tiles.length; i++) {
          for (let j = i + 1; j < tiles.length; j++) {
            const a = tiles[i].getBoundingClientRect();
            const b = tiles[j].getBoundingClientRect();
            const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (w > 1 && h > 1) { pairs++; worst = Math.max(worst, Math.min(w, h)); }
          }
        }
        return { pairs, worst: Math.round(worst) };
      }
    """)
    check("no two tiles overlap", overlap["pairs"] == 0, str(overlap))

    # --- no tile leaves the canvas --------------------------------------
    escape = pg.evaluate("""
      () => {
        const c = document.getElementById('heatmapCanvas');
        const cr = c.getBoundingClientRect();
        let n = 0;
        c.querySelectorAll('.hm-tile').forEach(t => {
          const r = t.getBoundingClientRect();
          if (r.right > cr.right + 1 || r.left < cr.left - 1 ||
              r.bottom > cr.bottom + 1 || r.top < cr.top - 1) n++;
        });
        return n;
      }
    """)
    check("no tile escapes the canvas", escape == 0, str(escape))

    # --- clicking a tile selects it -------------------------------------
    pg.click('#heatmapCanvas .hm-tile')
    pg.wait_for_timeout(3500)
    sel = pg.evaluate("""() => {
        const t = document.querySelector('#heatmapCanvas .hm-tile.is-selected');
        return t ? t.dataset.symbol : null;
    }""")
    check("clicking a tile selects that stock", sel is not None, str(sel))

    check("no page errors", len(errors) == 0, str(errors[:3]))
    b.close()

passed = sum(1 for _, ok in results if ok)
print(f"\n=== {passed}/{len(results)} heatmap checks passed ===")
sys.exit(0 if passed == len(results) else 1)
