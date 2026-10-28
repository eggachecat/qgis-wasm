#!/usr/bin/env python3
"""Smoke test of the minimal page (web/minimal/index.html): the browser passes the preflight, the module starts, the QGIS
main window paints onto the canvas, the overlay goes away, no uncaught page errors.

  python3 tests/e2e/minimal.py [--dir build/qgis/output/bin] [--port 8129] [--timeout 300]

Starts scripts/serve.mjs on --port for the given directory (which must contain the minimal page: scripts/stage-web.sh
of a checkout whose web/ has only web/minimal, or copy web/minimal/* over the bundle).
"""
import argparse, os, pathlib, subprocess, sys, time
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
CANVASES = "document.querySelector('#qt-shadow-container')?.shadowRoot?.querySelectorAll('canvas').length || 0"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(ROOT / "build/qgis/output/bin"))
    ap.add_argument("--port", type=int, default=8129)
    ap.add_argument("--timeout", type=int, default=300)
    args = ap.parse_args()
    os.environ.setdefault("no_proxy", "127.0.0.1,localhost")
    srv = subprocess.Popen(["node", str(ROOT / "scripts/serve.mjs"), "--port", str(args.port), "--dir", args.dir, "--no-proxy"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)
    failed = 0
    def check(name, ok, detail=""):
        nonlocal failed
        failed += 0 if ok else 1
        print(("  ✓ " if ok else "  ✗ ") + name + (f" — {detail}" if detail else ""), flush=True)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME, headless=True, args=["--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"])
            page = browser.new_context(viewport={"width": 1400, "height": 900}).new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            t0 = time.time()
            page.goto(f"http://127.0.0.1:{args.port}/index.html", wait_until="domcontentloaded")
            page.wait_for_function(f"() => ({CANVASES}) > 0 || window.qgisStatus === 'exited' || window.qgisStatus === 'unsupported'", timeout=args.timeout * 1000)
            status = page.evaluate("window.qgisStatus")
            check("the minimal page starts QGIS and the main window paints", status == "loaded" and page.evaluate(CANVASES) > 0, f"status {status}, {time.time() - t0:.1f}s")
            page.wait_for_function("() => document.getElementById('loading').classList.contains('hidden')", timeout=60000)
            check("the loading overlay goes away", True)
            page.wait_for_timeout(3000)
            page.screenshot(path=str(ROOT / "docs/screenshots/qgis-wasm-minimal.png"))
            check("no uncaught page errors", not errors, "; ".join(errors)[:200])
            browser.close()
    finally:
        srv.terminate()
    print("OK" if not failed else f"FAILED ({failed})")
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    main()
