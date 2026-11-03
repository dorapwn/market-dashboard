"""Probe the FX & Crypto panel: the label, the Hong Kong/China pairs, and
the group order (FX first, then crypto).

Usage:
    export PLAYWRIGHT_BROWSERS_PATH=/opt/data/.toolchain/pw-browsers
    /opt/data/.toolchain/browser-venv/bin/python test/browser/fx_probe.py [url]
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

    # --- the tab is labelled FX & Crypto -------------------------------
    labels = pg.evaluate("""() => [...document.querySelectorAll('.tab-bar .tab')]
        .map(t => t.textContent.trim())""")
    check("the tab is labelled 'FX & Crypto'", "FX & Crypto" in labels, str(labels))
    check("the old 'Crypto & FX' label is gone", "Crypto & FX" not in labels, str(labels))

    # --- open the panel -----------------------------------------------
    pg.click('.tab-bar .tab[data-tab="aux"]')
    pg.wait_for_timeout(2000)

    heading = pg.inner_text("#auxHeading")
    check("the panel heading says 'Foreign Exchange & Crypto'",
          "Foreign Exchange" in heading and "Crypto" in heading, heading)

    rows = pg.evaluate("""() => [...document.querySelectorAll('#auxBody tr[data-symbol]')]
        .map(tr => ({
            symbol: tr.dataset.symbol,
            cells: [...tr.querySelectorAll('td')].map(td => td.textContent.trim())
        }))""")
    syms = [r["symbol"] for r in rows]
    print("  rows:", syms)

    # --- the three new pairs are present --------------------------------
    for want in ["HKDCNY=X", "CNYHKD=X", "USDHKD=X"]:
        check(f"{want} is listed", want in syms, str(syms))

    # --- the FX rows come first ----------------------------------------
    groups = ["fx" if s.endswith("=X") else "crypto" for s in syms]
    check("the FX pairs come before the crypto",
          groups == sorted(groups, key=lambda g: 0 if g == "fx" else 1),
          str(groups))

    # --- every row has a price -----------------------------------------
    priced = {r["symbol"]: r["cells"][2] for r in rows}
    bad = {s: v for s, v in priced.items() if v in ("", "—", None)}
    check("every row has a live price", not bad, str(bad))

    # --- the Hong Kong pairs have sensible prices ----------------------
    # HKDCNY and CNYHKD are reciprocals of each other.
    try:
        hkdcny = float(priced["HKDCNY=X"].replace(",", ""))
        cnyhkd = float(priced["CNYHKD=X"].replace(",", ""))
        usdhkd = float(priced["USDHKD=X"].replace(",", ""))
        check("HKD/CNY and CNY/HKD are reciprocals",
              abs(hkdcny * cnyhkd - 1.0) < 0.01,
              f"{hkdcny} x {cnyhkd} = {hkdcny * cnyhkd:.4f}")
        check("HKD/CNY is around 0.85", 0.75 < hkdcny < 0.95, str(hkdcny))
        check("USD/HKD is around 7.85", 7.5 < usdhkd < 8.2, str(usdhkd))
    except (KeyError, ValueError) as e:
        check("the Hong Kong pairs have numeric prices", False, str(e))

    # --- clicking a new pair charts it ---------------------------------
    pg.click('#auxBody tr[data-symbol="HKDCNY=X"]')
    pg.wait_for_timeout(4000)
    chart_title = pg.inner_text("#chartHeading")
    check("clicking HKD/CNY charts it",
          "HKD" in chart_title and "CNY" in chart_title, chart_title)

    # --- sorting by symbol keeps the groups in order --------------------
    pg.click('.quote-table[data-table="aux"] th[data-sort="symbol"]')
    pg.wait_for_timeout(800)
    syms2 = pg.evaluate("""() => [...document.querySelectorAll('#auxBody tr[data-symbol]')]
        .map(tr => tr.dataset.symbol)""")
    groups2 = ["fx" if s.endswith("=X") else "crypto" for s in syms2]
    check("the FX block stays together when re-sorted",
          groups2 == sorted(groups2, key=lambda g: 0 if g == "fx" else 1), str(groups2))

    # --- the movers panel does not list FX pairs ------------------------
    pg.click('.tab-bar .tab[data-tab="movers"]')
    pg.wait_for_timeout(1500)
    mover_syms = pg.evaluate("""() => [...document.querySelectorAll('.movers-grid tr[data-symbol]')]
        .map(tr => tr.dataset.symbol)""")
    fx_in_movers = [s for s in mover_syms if s.endswith("=X")]
    check("no FX pair appears in the movers", not fx_in_movers, str(fx_in_movers))

    check("no page errors", len(errors) == 0, str(errors[:3]))
    b.close()

passed = sum(1 for _, ok in results if ok)
print(f"\n=== {passed}/{len(results)} FX & Crypto checks passed ===")
sys.exit(0 if passed == len(results) else 1)
