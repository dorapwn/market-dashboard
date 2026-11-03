/*
 * Browser probes for the market dashboard.
 *
 * These drive a real Chromium against the page and check what a unit test
 * cannot: that the chart is actually painted, that the treemap tiles do
 * not overlap, that clicking a row changes the visible selection.
 *
 * They need Playwright, which is NOT a project dependency — it lives in
 * the toolchain venv. Run them with:
 *
 *   export PLAYWRIGHT_BROWSERS_PATH=/opt/data/.toolchain/pw-browsers
 *   /opt/data/.toolchain/browser-venv/bin/python test/browser/<probe>.py [url]
 *
 * The URL defaults to a local server on port 8765:
 *
 *   python3 -m http.server 8765 --bind 127.0.0.1
 *
 * They are NOT run by CI — GitHub's runners have no browser here. They are
 * the local half of the verification, run before pushing.
 */
