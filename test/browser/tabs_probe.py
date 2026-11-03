"""Probe the tabbed workspace and the chart above it.

The chart is NOT a tab — it sits above the tab bar and is always visible,
because every table below it selects the symbol the chart shows.

Usage:
    export PLAYWRIGHT_BROWSERS_PATH=/opt/data/.toolchain/pw-browsers
    /opt/data/.toolchain/browser-venv/bin/python test/browser/tabs_probe.py [url]
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

    # --- the tab bar exists --------------------------------------------
    bar = pg.evaluate("""
      () => {
        const tabs = [...document.querySelectorAll('.tab-bar .tab')];
        return {
          count: tabs.length,
          labels: tabs.map(t => t.textContent.trim()),
          active: tabs.filter(t => t.classList.contains('is-active')).map(t => t.dataset.tab),
          selected: tabs.filter(t => t.getAttribute('aria-selected') === 'true').map(t => t.dataset.tab)
        };
      }
    """)
    check("a tab bar is present", bar["count"] == 6, f"{bar['count']} tabs: {bar['labels']}")
    check("there is no Chart tab", "Chart" not in bar["labels"], str(bar["labels"]))
    check("exactly one tab is active", len(bar["active"]) == 1, str(bar["active"]))
    check("the active tab is marked aria-selected", len(bar["selected"]) == 1, str(bar["selected"]))

    # --- the chart is above the tab bar and always visible --------------
    place = pg.evaluate("""
      () => {
        const chart = document.querySelector('.panel-chart');
        const bar = document.querySelector('.tab-bar');
        const c = chart.getBoundingClientRect();
        const b = bar.getBoundingClientRect();
        const host = document.getElementById('chartHost');
        const canvas = host.querySelector('canvas');
        return {
          chartTop: Math.round(c.top),
          barTop: Math.round(b.top),
          chartVisible: c.height > 0 && c.width > 0,
          hostW: host.clientWidth,
          canvasW: canvas ? canvas.width : 0,
          canvasH: canvas ? canvas.height : 0,
          chartIsPanel: !!chart.closest('.tab-panel'),
          heading: document.getElementById('chartHeading').textContent
        };
      }
    """)
    check("the chart sits above the tab bar", place["chartTop"] < place["barTop"],
          f"chart top {place['chartTop']}, bar top {place['barTop']}")
    check("the chart is not inside a tab panel", not place["chartIsPanel"])
    check("the chart is visible on load", place["chartVisible"])
    check("the chart canvas has real pixels",
          place["canvasW"] > 100 and place["canvasH"] > 50,
          f"{place['canvasW']}x{place['canvasH']}")
    check("the chart has a heading", place["heading"] not in ("", "—"), place["heading"])

    # --- exactly one panel visible --------------------------------------
    def visible_panels():
        return pg.evaluate("""
          () => [...document.querySelectorAll('.tab-panel')]
            .filter(p => p.getBoundingClientRect().height > 0)
            .map(p => p.dataset.panel)
        """)

    vis = visible_panels()
    check("exactly one panel is visible", len(vis) == 1, str(vis))
    check("the visible panel matches the active tab",
          vis == bar["active"], f"{vis} vs {bar['active']}")

    # --- switching ------------------------------------------------------
    for key in ["portfolio", "heatmap", "watchlist", "movers", "aux", "indices"]:
        pg.click(f'.tab-bar .tab[data-tab="{key}"]')
        pg.wait_for_timeout(1400)
        vis = visible_panels()
        check(f"switching to {key} shows only that panel", vis == [key], str(vis))

    # --- the chart stays visible and correct across switches ------------
    pg.click('.tab-bar .tab[data-tab="watchlist"]')
    pg.wait_for_timeout(800)
    still = pg.evaluate("""
      () => {
        const c = document.querySelector('.panel-chart');
        const r = c.getBoundingClientRect();
        const canvas = document.querySelector('#chartHost canvas');
        return { h: Math.round(r.height), w: canvas ? canvas.width : 0 };
      }
    """)
    check("the chart is still visible after switching tabs", still["h"] > 100, str(still["h"]))
    check("the chart canvas keeps its size", still["w"] > 100, str(still["w"]))

    # --- clicking a row updates the chart above the tabs ---------------
    pg.click(".tab-bar .tab[data-tab='indices']")
    pg.wait_for_timeout(800)
    before = pg.inner_text("#chartHeading")
    pg.click("#indexBody tr:nth-child(2)")
    pg.wait_for_timeout(3500)
    after = pg.inner_text("#chartHeading")
    check("clicking an index row updates the chart above the tabs",
          after != before, f"{before} -> {after}")

    # --- the heatmap renders when its tab is opened --------------------
    pg.click('.tab-bar .tab[data-tab="heatmap"]')
    pg.wait_for_timeout(4000)
    heat = pg.evaluate("""
      () => {
        const c = document.getElementById('heatmapCanvas');
        const tiles = [...c.querySelectorAll('.hm-tile')];
        const cr = c.getBoundingClientRect();
        let escaping = 0;
        tiles.forEach(t => {
          const r = t.getBoundingClientRect();
          if (r.right > cr.right + 1 || r.left < cr.left - 1 ||
              r.bottom > cr.bottom + 1 || r.top < cr.top - 1) escaping++;
        });
        return { tiles: tiles.length, canvasW: c.clientWidth, escaping: escaping };
      }
    """)
    check("the heatmap renders when its tab is opened", heat["tiles"] > 400,
          f"{heat['tiles']} tiles, canvas {heat['canvasW']}px")
    check("no heatmap tile escapes the canvas", heat["escaping"] == 0, str(heat["escaping"]))

    # --- keyboard navigation -------------------------------------------
    pg.click('.tab-bar .tab[data-tab="indices"]')
    pg.wait_for_timeout(500)
    pg.focus('.tab-bar .tab[data-tab="indices"]')
    pg.keyboard.press("ArrowRight")
    pg.wait_for_timeout(600)
    vis = visible_panels()
    check("ArrowRight moves to the next tab", vis == ["portfolio"], str(vis))
    focused = pg.evaluate("() => document.activeElement.dataset.tab")
    check("focus follows the arrow key", focused == "portfolio", str(focused))

    pg.keyboard.press("End")
    pg.wait_for_timeout(600)
    vis = visible_panels()
    check("End jumps to the last tab", vis == ["aux"], str(vis))

    pg.keyboard.press("Home")
    pg.wait_for_timeout(600)
    vis = visible_panels()
    check("Home jumps to the first tab", vis == ["indices"], str(vis))

    # --- roving tabindex ------------------------------------------------
    ti = pg.evaluate("""
      () => [...document.querySelectorAll('.tab-bar .tab')]
        .map(t => [t.dataset.tab, t.getAttribute('tabindex')])
    """)
    zeros = [t for t, i in ti if i == "0"]
    check("only the active tab is in the tab order",
          len(zeros) == 1 and zeros[0] == "indices", str(ti))

    check("no page errors", len(errors) == 0, str(errors[:3]))
    b.close()

passed = sum(1 for _, ok in results if ok)
print(f"\n=== {passed}/{len(results)} tab checks passed ===")
sys.exit(0 if passed == len(results) else 1)
