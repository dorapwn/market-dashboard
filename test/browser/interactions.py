"""Probe the dashboard interactions: selection, sorting, the chart ranges
and the refresh button.

Usage:
    export PLAYWRIGHT_BROWSERS_PATH=/opt/data/.toolchain/pw-browsers
    /opt/data/.toolchain/browser-venv/bin/python test/browser/interactions.py [url]
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

    def heading():
        return pg.inner_text("#chartHeading")

    def open_tab(key):
        pg.click(f'.tab-bar .tab[data-tab="{key}"]')
        pg.wait_for_timeout(1400)

    # --- selecting a watchlist row -------------------------------------
    print("=== selecting a row ===")
    open_tab("watchlist")
    before = heading()
    pg.click("#watchlistBody tr:nth-child(3)")
    pg.wait_for_timeout(3500)
    after = heading()
    check("clicking a watchlist row changes the chart", after != before, f"{before} -> {after}")

    sel = pg.evaluate("""() => {
        const r = document.querySelector('#watchlistBody tr.is-selected');
        return r ? r.dataset.symbol : null;
    }""")
    check("the clicked row is marked selected", sel is not None, str(sel))

    # --- sorting --------------------------------------------------------
    print("=== sorting ===")
    open_tab("indices")

    def index_changes():
        # The sign is already in the text, so parseFloat handles it: the
        # only thing to strip is the "+" and the "%". (Stripping the
        # digits first and then applying the sign separately would
        # double-negate the negative rows.)
        return pg.evaluate("""() => [...document.querySelectorAll('#indexBody tr')]
            .map(tr => {
                const tds = tr.querySelectorAll('td');
                const td = tds[tds.length - 1];
                const v = td ? td.textContent.trim() : '';
                const n = parseFloat(v.replace(/[+%,]/g, ''));
                return isNaN(n) ? null : n;
            })""")

    pg.click('.quote-table[data-table="indices"] th[data-sort="changePct"]')
    pg.wait_for_timeout(1200)
    changes = index_changes()
    check("sorting by change puts the indices in descending order",
          all(changes[i] >= changes[i + 1] for i in range(len(changes) - 1)),
          str(changes))

    # One table's sort must not touch another's. The indices header is
    # only clickable while the indices panel is showing, so the click goes
    # through the tab switch first.
    open_tab("watchlist")
    w_first = pg.inner_text("#watchlistBody tr:nth-child(1) .sym-cell")
    open_tab("indices")
    pg.click('.quote-table[data-table="indices"] th[data-sort="name"]')
    pg.wait_for_timeout(1000)
    open_tab("watchlist")
    w_after = pg.inner_text("#watchlistBody tr:nth-child(1) .sym-cell")
    check("one table's sort does not re-sort another",
          w_first == w_after, f"{w_first} -> {w_after}")

    # --- the chart ranges ------------------------------------------------
    print("=== switching chart range ===")
    # The chart is not a tab — it is always visible above the tab bar.
    pg.click(".range-tab[data-range='1y']")
    pg.wait_for_timeout(4000)
    sub = pg.inner_text("#chartSub")
    check("the 1Y range is applied", "1 year" in sub, sub)

    # --- the auto refresh toggle ----------------------------------------
    print("=== auto refresh toggle ===")
    btn = pg.query_selector("#autoToggle")
    label_before = btn.inner_text()
    pressed_before = btn.get_attribute("aria-pressed")
    btn.click()
    pg.wait_for_timeout(600)
    pressed_after = btn.get_attribute("aria-pressed")
    check("the auto button toggles its pressed state",
          pressed_before != pressed_after, f"{pressed_before} -> {pressed_after}")
    btn.click()
    pg.wait_for_timeout(600)
    check("the auto button toggles back",
          pg.get_attribute("#autoToggle", "aria-pressed") == pressed_before,
          str(pg.get_attribute("#autoToggle", "aria-pressed")))

    # --- the refresh button ----------------------------------------------
    print("=== manual refresh button ===")
    pg.click("#refreshBtn")
    samples = []
    for _ in range(30):
        samples.append(pg.evaluate("() => document.getElementById('refreshBtn').disabled"))
        if not samples[-1]:
            break
        pg.wait_for_timeout(200)
    check("the refresh button is disabled while the request is in flight",
          any(samples), f"{len(samples)} samples")
    check("the refresh button re-enables when the request finishes",
          not samples[-1], str(samples[-1]))

    check("no page errors", len(errors) == 0, str(errors[:3]))
    b.close()

passed = sum(1 for _, ok in results if ok)
print(f"\n=== {passed}/{len(results)} interaction checks passed ===")
sys.exit(0 if passed == len(results) else 1)
