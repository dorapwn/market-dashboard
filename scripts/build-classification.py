"""
Build the S&P 500 classification snapshot.

Pulls GICS Sector + GICS Sub-Industry for every S&P 500 constituent from
the Wikipedia MediaWiki API (structured wikitext, no HTML scraping), and
writes them into data/snapshot.json alongside the quotes.

Why Wikipedia rather than Yahoo:
  * Yahoo's quoteSummary/v7-quote endpoints require a crumb + cookie and
    are rejected (401 Invalid Crumb) from this environment.
  * The Yahoo screener endpoint works but returns no sector/industry field.
  * Wikipedia's table carries the same GICS taxonomy the heatmap needs and
    is fetchable server-side with no authentication.

The classification changes only when the index committee rebalances, so it
is baked into the snapshot and refreshed by the daily workflow rather than
on every page load.
"""

import json
import os
import re
import sys
import urllib.request

API = "https://en.wikipedia.org/w/api.php"
UA = "market-dashboard/1.0 (https://github.com/dorapwn/market-dashboard)"

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SNAPSHOT = os.path.join(ROOT, "data", "snapshot.json")


def fetch_wikitext():
    params = (
        "?action=parse&page=List_of_S%26P_500_companies"
        "&prop=wikitext&format=json&section=1"
    )
    req = urllib.request.Request(API + params, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read().decode("utf-8"))
    return data["parse"]["wikitext"]["*"]


def clean(cell):
    """Reduce a wikitext cell to a plain string."""
    txt = cell.strip()
    # [[Link|Display]] -> Display ;  [[Link]] -> Link
    txt = re.sub(r"\[\[([^\]|]*)\|([^\]]*)\]\]", r"\2", txt)
    txt = re.sub(r"\[\[([^\]]*)\]\]", r"\1", txt)
    # {{NyseSymbol|MMM}} -> MMM
    txt = re.sub(r"\{\{[^|{}]*\|([^|{}]*)\}\}", r"\1", txt)
    txt = re.sub(r"\{\{[^|{}]*\}\}", "", txt)
    txt = re.sub(r"<ref[^>]*/>", "", txt)
    txt = re.sub(r"<ref[^>]*>.*?</ref>", "", txt, flags=re.S)
    txt = re.sub(r"'''?", "", txt)
    txt = re.sub(r"<[^>]+>", "", txt)
    txt = txt.replace("&nbsp;", " ").replace("&amp;", "&")
    return re.sub(r"\s+", " ", txt).strip()


# The 11 GICS sectors. A parsed row must land on one of these, which catches
# rows whose wikitext cells are misaligned (a missing newline before '||'
# merges the name and sector into one cell).
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


def parse_table(wikitext):
    """Return [{symbol, name, sector, industry}] for the constituents table."""
    start = wikitext.find('id="constituents"')
    if start == -1:
        raise RuntimeError("constituents table not found")
    body = wikitext[start:]
    end = body.find("\n|}")
    if end != -1:
        body = body[:end]

    # Rows are separated by '|-'. The first row is the header; every data
    # row begins with an empty cell, then the symbol.
    rows = body.split("\n|-")
    out = []
    skipped = []
    for row in rows[1:]:
        # Split on '||' with or without a leading newline: a few rows omit the
        # newline before the separator, which would otherwise merge the name
        # and sector into a single cell.
        cells = [clean(c) for c in re.split(r"\n?\|\|", row)]
        # A data row is: "", symbol, name, sector, industry, ...
        if cells and cells[0] == "":
            cells = cells[1:]
        if len(cells) < 4:
            continue
        symbol, name, sector, industry = cells[0], cells[1], cells[2], cells[3]
        if not symbol or not sector or not industry:
            continue
        # Guard against stray rows (headers, notes).
        if not re.fullmatch(r"[A-Z.\-]{1,6}", symbol):
            continue
        # A valid row's sector must be a real GICS sector. Anything else means
        # the columns are misaligned, so the row is rejected rather than
        # publishing a wrong classification.
        if sector not in GICS_SECTORS:
            skipped.append((symbol, name, sector, industry))
            continue
        out.append(
            {
                "symbol": symbol.replace(".", "-"),
                "name": name,
                "sector": sector,
                "industry": industry,
            }
        )
    if skipped:
        print(f"  rejected {len(skipped)} misaligned rows:")
        for row in skipped:
            print("   ", row)
    return out


def main():
    print("fetching S&P 500 classifications from Wikipedia...")
    try:
        wikitext = fetch_wikitext()
    except Exception as exc:  # noqa: BLE001
        print("FETCH FAILED:", exc, file=sys.stderr)
        return 1

    rows = parse_table(wikitext)
    print(f"parsed {len(rows)} constituents")

    sectors = sorted({r["sector"] for r in rows})
    print(f"{len(sectors)} sectors:")
    for s in sectors:
        n = sum(1 for r in rows if r["sector"] == s)
        print(f"  {s:35s} {n:4d} stocks, {len({r['industry'] for r in rows if r['sector'] == s})} industries")

    with open(SNAPSHOT) as fh:
        snap = json.load(fh)

    quotes = snap.setdefault("quotes", {})
    sym2meta = {r["symbol"]: r for r in rows}

    # Attach the classification to any quote we already have.
    attached = 0
    for sym, q in quotes.items():
        meta = sym2meta.get(sym)
        if meta:
            q["sector"] = meta["sector"]
            q["industry"] = meta["industry"]
            q["name"] = meta["name"]
            attached += 1

    # Include constituents we do not quote yet, so the heatmap can show the
    # full index. Their price is absent until the quote pass picks them up.
    for r in rows:
        if r["symbol"] not in quotes:
            quotes[r["symbol"]] = {
                "symbol": r["symbol"],
                "name": r["name"],
                "sector": r["sector"],
                "industry": r["industry"],
                "price": None,
                "changePct": None,
                "closes": [],
            }

    snap["classification"] = {
        "source": "wikipedia:List_of_S%26P_500_companies",
        "taxonomy": "GICS",
        "count": len(rows),
        "updated": snap.get("updated"),
        "bySymbol": {r["symbol"]: {"sector": r["sector"], "industry": r["industry"], "name": r["name"]} for r in rows},
    }
    snap["count"] = len(quotes)

    with open(SNAPSHOT, "w") as fh:
        json.dump(snap, fh, indent=2, sort_keys=True)
        fh.write("\n")

    print(f"attached classification to {attached} existing quotes")
    print(f"snapshot now carries {len(quotes)} quotes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
