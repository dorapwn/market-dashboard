"""Probe the fundamentals panel under the chart.

Checks that:
  - the panel is absent for an index and present for an equity
  - the four metric groups render with real values
  - a Hong Kong stock (CNY statements, HKD price) gets a converted P/E
  - no "NaN", "undefined" or "null" ever reaches the screen

Usage:
    export PLAYWRIGHT_BROWSERS_PATH=/opt/data/.toolchain/pw-browsers
    /opt/data/.toolchain/browser-venv/bin/python test/browser/fundamentals_probe.py [url]
"""
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765/"

checks = []


def check(label, ok, detail=""):
    checks.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"   {detail}" if detail else ""))


def open_tab(pg, key):
    pg.click(f'.tab-bar .tab[data-tab="{key}"]')
    pg.wait_for_timeout(400)


def select(pg, symbol, table="watchlist"):
    """Click a row carrying data-symbol, inside one specific table.

    The same symbol appears in several tables, and the hidden ones are not
    clickable, so the table has to be named.
    """
    pg.click(f'.quote-table[data-table="{table}"] tr[data-symbol="{symbol}"]')
    pg.wait_for_timeout(3500)


with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox"])
    pg = browser.new_page(viewport={"width": 1600, "height": 1200})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(URL, wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(14000)

    # --- the default selection is an index, so there is no panel --------
    print("=== the index default ===")
    hidden = pg.get_attribute("#fundamentals", "hidden") is not None
    check("the fundamentals panel is hidden for the S&P 500", hidden)

    # --- an equity gets the panel --------------------------------------
    print("=== an equity ===")
    open_tab(pg, "watchlist")
    select(pg, "MSFT")

    hidden = pg.get_attribute("#fundamentals", "hidden") is not None
    check("the fundamentals panel is shown for MSFT", not hidden)

    groups = pg.eval_on_selector_all(
        "#fundGroups .fund-group-title", "els => els.map(e => e.textContent.trim())")
    check("the four metric groups are present",
          groups == ["Valuation", "Cash flow", "Profitability", "Balance sheet"],
          str(groups))

    metrics = pg.eval_on_selector_all(
        "#fundGroups .fund-metric", """els => els.map(e => ({
            label: e.querySelector('.fund-metric-label').textContent.trim(),
            value: e.querySelector('.fund-metric-value').textContent.trim()
        }))""")
    check("the metrics carry labels and values",
          len(metrics) >= 18 and all(m["label"] for m in metrics), f"{len(metrics)} metrics")

    by_label = {m["label"]: m["value"] for m in metrics}
    pe = by_label.get("P/E (TTM)", "")
    check("the P/E is a real number", pe.endswith("×") and "NaN" not in pe, pe)
    check("the revenue is shown", by_label.get("Revenue (TTM)", "—") != "—",
          by_label.get("Revenue (TTM)", ""))
    check("the free cash flow is shown", by_label.get("Free CF", "—") != "—",
          by_label.get("Free CF", ""))
    check("the gross margin is shown", "%" in by_label.get("Gross margin", ""),
          by_label.get("Gross margin", ""))
    check("the revenue growth is shown", "%" in by_label.get("Revenue YoY", ""),
          by_label.get("Revenue YoY", ""))
    check("the net debt is shown", by_label.get("Net debt", "—") != "—",
          by_label.get("Net debt", ""))

    meta = pg.inner_text("#fundMeta")
    check("the panel says which currency it is in", "USD" in meta, meta)

    # --- nothing broken is on screen -----------------------------------
    body = pg.inner_text("body")
    for bad in ("NaN", "undefined", "[object Object]", "Infinity"):
        check(f"the page does not show {bad!r}", bad not in body)

    # --- the panel sits under the chart --------------------------------
    print("=== placement ===")
    box_chart = pg.query_selector(".panel-chart").bounding_box()
    box_stats = pg.query_selector("#chartStats").bounding_box()
    box_fund = pg.query_selector("#fundamentals").bounding_box()
    check("the chart is above the stats", box_chart["y"] < box_stats["y"])
    check("the stats are above the fundamentals", box_stats["y"] < box_fund["y"])

    # --- a Hong Kong stock: CNY statements, HKD price ------------------
    # The page only tracks US equities, so the currency trap is exercised
    # against the model directly in the browser, with the real Yahoo
    # numbers for Tencent. That is the case the model exists for.
    print("=== a Hong Kong stock: CNY statements, HKD price ===")
    hk = pg.evaluate("""async () => {
        const raw = await fetch('https://r.jina.ai/https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/0700.HK?symbol=0700.HK&type=trailingTotalRevenue,trailingNetIncome,trailingFreeCashFlow,trailingDilutedEPS,trailingMarketCap&period1=1400000000&period2=1900000000',
            {headers: {'x-respond-with': 'text'}}).then(r => r.text());
        const payload = JSON.parse(raw.slice(raw.indexOf('{')));
        const parsed = window.FundamentalsModel.parse(payload, '0700.HK');

        // The HKD price and the HKD market cap, as the page would have.
        const quote = {price: 394, currency: 'HKD'};
        const noRate = window.FundamentalsModel.derive(parsed, {
            price: quote.price, quoteCurrency: quote.currency
        });
        const withRate = window.FundamentalsModel.derive(parsed, {
            price: quote.price, quoteCurrency: quote.currency, fxRate: 1.1759
        });
        return {
            currency: parsed.currency,
            crossCurrency: noRate.crossCurrency,
            peWithoutRate: noRate.valuation.pe,
            peWithRate: withRate.valuation.pe,
            notes: noRate.notes,
            netMargin: withRate.profitability.netMargin
        };
    }""")

    check("the statements are in CNY and the price in HKD", hk["currency"] == "CNY" and hk["crossCurrency"],
          f"currency={hk['currency']} cross={hk['crossCurrency']}")
    check("without a rate the P/E is left empty rather than wrong",
          hk["peWithoutRate"] is None, str(hk["peWithoutRate"]))
    check("the panel explains why the P/E is missing", len(hk["notes"]) > 0, str(hk["notes"]))
    check("with a rate the P/E is computed",
          isinstance(hk["peWithRate"], (int, float)) and hk["peWithRate"] > 0,
          str(hk["peWithRate"]))
    check("the net margin is a ratio of the statement figures",
          abs(hk["netMargin"] - (235508000000 / 788483000000)) < 1e-6, str(hk["netMargin"]))

    print("=== errors ===")
    check("no page errors", not errors, str(errors))

    browser.close()

passed = sum(1 for c in checks if c)
print(f"\n=== {passed}/{len(checks)} fundamentals checks passed ===")
sys.exit(0 if passed == len(checks) else 1)
