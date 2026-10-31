"""
Build the S&P 500 heatmap dataset.

The heatmap needs, for every S&P 500 constituent:
    price, change %, market cap, GICS sector, GICS sub-industry

Sources, and why each one:
  * GICS sector + sub-industry -> Wikipedia's MediaWiki API. Yahoo's
    quoteSummary and v7-quote endpoints both require a crumb+cookie and
    return 401 "Invalid Crumb" from this environment, and the screener
    endpoint returns no sector field at all.
  * price + change %        -> Yahoo spark endpoint (20 symbols per request).
  * market cap              -> price x shares outstanding. Shares come from
    Yahoo's fundamentals-timeseries endpoint. The screener endpoint does
    carry marketCap, but its predefined screens only cover ~200 of the 502
    constituents, so it cannot size the whole index.

Both Yahoo endpoints are called directly (not through the CORS proxy) since
this runs server-side; the browser still uses the proxy at runtime.

Market cap is only used to SIZE the tiles. It is index-wide public data
about whole companies, not portfolio data — nothing here is about any
individual's holdings.

Output: data/heatmap.json
"""

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SNAPSHOT = os.path.join(ROOT, "data", "snapshot.json")
OUT = os.path.join(ROOT, "data", "heatmap.json")

WIKI_API = "https://en.wikipedia.org/w/api.php"
SPARK = "https://query1.finance.yahoo.com/v7/finance/spark"
TIMESERIES = "https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries"

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

GICS_SECTORS = {
    "Communication Services",
    "Consumer Discretionary",
    "Consumer Staples",
    "Energy",
    "Financials",
    "Health Care",
    "Industrials",
    "Information Technology",
    "Materials",
    "Real Estate",
    "Utilities",
}

# Which GICS sectors count as "tech" for the top-level split.
TECH_SECTORS = {"Information Technology", "Communication Services"}


def http_json(url, timeout=45, retries=3):
    """GET JSON with a few retries. Returns None on persistent failure."""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read().decode("utf-8", "replace")
            # The r.jina.ai proxy prefixes a text header; find the JSON.
            for opener in ('{"finance"', '{"chart"', '{"spark"', '{"timeseries"', '{"parse"'):
                i = body.find(opener)
                if i != -1:
                    body = body[i:]
                    break
            return json.loads(body)
        except Exception as exc:  # noqa: BLE001
            if attempt == retries - 1:
                print(f"    giving up: {exc}", file=sys.stderr)
                return None
            time.sleep(1.5 * (attempt + 1))
    return None


def clean(cell):
    txt = cell.strip()
    txt = re.sub(r"\[\[([^\]|]*)\|([^\]]*)\]\]", r"\2", txt)
    txt = re.sub(r"\[\[([^\]]*)\]\]", r"\1", txt)
    txt = re.sub(r"\{\{[^|{}]*\|([^|{}]*)\}\}", r"\1", txt)
    txt = re.sub(r"\{\{[^|{}]*\}\}", "", txt)
    txt = re.sub(r"<ref[^>]*/>", "", txt)
    txt = re.sub(r"<ref[^>]*>.*?</ref>", "", txt, flags=re.S)
    txt = re.sub(r"'''?", "", txt)
    txt = re.sub(r"<[^>]+>", "", txt)
    txt = txt.replace("&nbsp;", " ").replace("&amp;", "&")
    return re.sub(r"\s+", " ", txt).strip()


def fetch_classification():
    params = (
        "?action=parse&page=List_of_S%26P_500_companies"
        "&prop=wikitext&format=json&section=1"
    )
    data = http_json(WIKI_API + params)
    if not data or "parse" not in data:
        raise RuntimeError("wikipedia fetch failed")
    wikitext = data["parse"]["wikitext"]["*"]
    body = wikitext[wikitext.find('id="constituents"'):]
    rows = body.split("\n|-")
    out = []
    for row in rows[1:]:
        cells = [clean(c) for c in re.split(r"\n?\|\|", row)]
        if cells and cells[0] == "":
            cells = cells[1:]
        if len(cells) < 4:
            continue
        symbol, name, sector, industry = cells[0], cells[1], cells[2], cells[3]
        if not symbol or not sector or not industry:
            continue
        if not re.fullmatch(r"[A-Z.\-]{1,6}", symbol):
            continue
        if sector not in GICS_SECTORS:
            continue
        out.append(
            {
                "symbol": symbol.replace(".", "-"),
                "name": name,
                "sector": sector,
                "industry": industry,
            }
        )
    return out


def fetch_prices(symbols):
    """Batch prices from the spark endpoint (20 symbols per request)."""
    prices = {}
    groups = [symbols[i:i + 20] for i in range(0, len(symbols), 20)]
    for gi, group in enumerate(groups):
        url = (
            SPARK + "?symbols=" + urllib.parse.quote(",".join(group))
            + "&range=1d&interval=1d"
        )
        data = http_json(url)
        if not data:
            print(f"  price chunk {gi + 1}/{len(groups)} failed", file=sys.stderr)
            continue
        for entry in (data.get("spark", {}).get("result") or []):
            resp = (entry.get("response") or [None])[0]
            if not resp:
                continue
            m = resp.get("meta") or {}
            price = m.get("regularMarketPrice")
            prev = m.get("chartPreviousClose")
            if prev is None:
                prev = m.get("previousClose")
            chg = None
            if isinstance(price, (int, float)) and isinstance(prev, (int, float)) and prev:
                chg = (price - prev) / prev * 100
            elif m.get("regularMarketChangePercent") is not None:
                chg = m.get("regularMarketChangePercent")
            if price is None:
                continue
            prices[entry["symbol"]] = {
                "price": price,
                "changePct": chg,
                "name": m.get("shortName") or m.get("longName"),
            }
        if gi % 5 == 0:
            print(f"  prices: chunk {gi + 1}/{len(groups)} ({len(prices)} symbols)")
        time.sleep(0.4)
    return prices


def fetch_shares(symbol):
    """Shares outstanding for one symbol."""
    url = (
        f"{TIMESERIES}/{symbol}?symbol={symbol}&type=quarterlyOrdinarySharesNumber,"
        "annualOrdinarySharesNumber&merge=false&period1=1500000000&period2=1800000000"
    )
    data = http_json(url, timeout=30, retries=2)
    if not data:
        return None
    best = None
    for entry in (data.get("timeseries", {}).get("result") or []):
        for key in ("quarterlyOrdinarySharesNumber", "annualOrdinarySharesNumber"):
            series = entry.get(key)
            if series:
                raw = series[-1].get("reportedValue", {}).get("raw")
                if isinstance(raw, (int, float)) and raw > 0:
                    best = raw if best is None else max(best, raw)
    return best


def main():
    print("fetching GICS classification from Wikipedia...")
    rows = fetch_classification()
    print(f"  {len(rows)} constituents across {len({r['sector'] for r in rows})} sectors")

    symbols = [r["symbol"] for r in rows]

    print("fetching prices from Yahoo spark...")
    prices = fetch_prices(symbols)
    print(f"  got prices for {len(prices)}/{len(symbols)}")

    print("fetching shares outstanding (one request per symbol)...")
    shares = {}
    for i, sym in enumerate(symbols):
        if sym not in prices:
            continue
        s = fetch_shares(sym)
        if s:
            shares[sym] = s
        if (i + 1) % 50 == 0:
            print(f"  shares: {i + 1}/{len(symbols)} ({len(shares)} found)")

    print(f"  got shares for {len(shares)}/{len(symbols)}")

    items = []
    for r in rows:
        sym = r["symbol"]
        p = prices.get(sym)
        if not p:
            continue
        sh = shares.get(sym)
        cap = p["price"] * sh if sh else None
        items.append(
            {
                "symbol": sym,
                "name": r["name"] or p.get("name") or sym,
                "sector": r["sector"],
                "industry": r["industry"],
                "price": round(p["price"], 4) if p["price"] else None,
                "changePct": round(p["changePct"], 4) if p["changePct"] is not None else None,
                "marketCap": int(cap) if cap else None,
                "group": "tech" if r["sector"] in TECH_SECTORS else "nontech",
            }
        )

    # Sector + industry rollups for the treemap's nested layout.
    sectors = {}
    for it in items:
        s = sectors.setdefault(
            it["sector"],
            {"sector": it["sector"], "group": it["group"], "items": [], "marketCap": 0},
        )
        s["items"].append(it)
        s["marketCap"] += it["marketCap"] or 0
    for s in sectors.values():
        s["items"].sort(key=lambda x: -(x["marketCap"] or 0))

    payload = {
        "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "wikipedia(GICS) + yahoo(spark, timeseries)",
        "count": len(items),
        "sectors": sorted(sectors.values(), key=lambda s: -s["marketCap"]),
        "items": sorted(items, key=lambda x: -(x["marketCap"] or 0)),
    }

    with open(OUT, "w") as fh:
        json.dump(payload, fh, indent=1, sort_keys=True)
        fh.write("\n")

    capcount = sum(1 for i in items if i["marketCap"])
    print(f"wrote {OUT}: {len(items)} stocks, {capcount} with market cap, "
          f"{len(sectors)} sectors, {len(payload['sectors'])} sector groups")

    # Also record the classification in the main snapshot for the watchlist.
    if os.path.exists(SNAPSHOT):
        with open(SNAPSHOT) as fh:
            snap = json.load(fh)
        cls = snap.setdefault("classification", {})
        cls["bySymbol"] = {
            r["symbol"]: {"sector": r["sector"], "industry": r["industry"], "name": r["name"]}
            for r in rows
        }
        cls["count"] = len(rows)
        cls["updated"] = payload["updated"]
        with open(SNAPSHOT, "w") as fh:
            json.dump(snap, fh, indent=2, sort_keys=True)
            fh.write("\n")
        print("  updated snapshot.json classification")

    return 0


if __name__ == "__main__":
    sys.exit(main())
