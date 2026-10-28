#!/usr/bin/env python3
"""Browser regression test for the QGIS WebAssembly build.

Serves build/qgis/output/bin with COOP/COEP headers, opens the page in headless Chrome (SwiftShader WebGL,
JSPI) and checks that the real QGIS desktop comes up and works:
  1. the main window is created (a Qt window canvas appears) and the welcome page renders
  2. with --open: the demo project is loaded through the JS bridge and the map canvas shows rendered land pixels
  3. a modal dialog (Settings → Options, QDialog::exec() = nested event loop via JSPI) opens as a second window and closes
Screenshots go to docs/screenshots/.

  python3 tests/e2e/smoke.py [--open /qgis/share/demo/world.qgs] [--timeout 300] [--keep]
"""
import argparse, os, subprocess, sys, time, pathlib, json
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
CANVASES = "document.querySelector('#qt-shadow-container')?.shadowRoot?.querySelectorAll('canvas').length || 0"
LAND = (180, 210, 180)  # fill colour of the demo "Countries" layer

def pixel(page, x, y):
    return tuple(page.evaluate(f"(() => {{ const c = document.querySelector('#qt-shadow-container').shadowRoot.querySelector('canvas');"
                               f" return Array.from(c.getContext('2d').getImageData({x}, {y}, 1, 1).data).slice(0, 3); }})()"))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(ROOT / "build/qgis/output/bin"))
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--open", default="/qgis/share/demo/world.qgs", help="project/data to open through ?open= ('' to skip)")
    ap.add_argument("--remote", default="", help="also open this http(s) URL through window.qgisOpen() (CDN / object storage test)")
    ap.add_argument("--keep", action="store_true", help="headed browser, kept open afterwards")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    server = subprocess.Popen(["node", str(ROOT / "scripts/serve.mjs"), "--port", str(args.port), "--dir", os.path.relpath(args.dir, ROOT)],
                              cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    time.sleep(1.0)
    shots = ROOT / "docs/screenshots"; shots.mkdir(parents=True, exist_ok=True)
    console, failures, results = [], [], []
    def check(name, ok, detail=""):
        results.append((name, ok, detail)); print(("  ✓ " if ok else "  ✗ ") + name + (f" — {detail}" if detail else ""))
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME, headless=not args.keep, args=[
                "--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"])
            page = browser.new_context(viewport={"width": 1600, "height": 950}).new_page()
            page.on("console", lambda m: console.append(f"[{m.type}] {m.text}"))
            page.on("pageerror", lambda e: failures.append(f"pageerror: {e}"))
            t0 = time.time()
            url = f"http://127.0.0.1:{args.port}/index.html" + (f"?open={args.open}" if args.open else "")
            page.goto(url, wait_until="domcontentloaded")
            page.wait_for_function(f"() => ({CANVASES}) > 0 || window.qgisStatus === 'exited'", timeout=args.timeout * 1000)
            check("QGIS main window created", page.evaluate("window.qgisStatus") == "loaded", f"{time.time()-t0:.1f}s, threads={page.evaluate('window.qgisInfo.threads')}, jspi={page.evaluate('window.qgisInfo.jspi')}")
            page.wait_for_timeout(6000)
            page.screenshot(path=str(shots / "qgis-wasm-startup.png"))
            if args.open:
                # the demo project renders land in the middle of the canvas once the parallel render job finished
                deadline = time.time() + 90
                while time.time() < deadline and pixel(page, 1000, 450) != LAND:
                    page.wait_for_timeout(1000)
                check("project opened and map rendered", pixel(page, 1000, 450) == LAND, f"pixel(1000,450)={pixel(page, 1000, 450)} after {time.time()-t0:.1f}s")
                page.screenshot(path=str(shots / "qgis-wasm-world-map.png"))
            if args.remote:
                # fetch a remote dataset into the virtual filesystem and hand it to QgisApp::openFile();
                # OGR offers its sublayer(s) in the (modal) "Select Items to Add" dialog, Enter adds them
                page.evaluate(f"window.qgisOpen({json.dumps(args.remote)})")
                deadline = time.time() + 120
                while time.time() < deadline and page.evaluate(CANVASES) < 3:
                    page.wait_for_timeout(1000)
                check("remote file fetched, sublayer dialog shown", page.evaluate(CANVASES) >= 3, f"canvases={page.evaluate(CANVASES)} after {time.time()-t0:.1f}s")
                page.screenshot(path=str(shots / "qgis-wasm-remote-sublayers.png"))
                page.keyboard.press("Enter"); page.wait_for_timeout(8000)
                check("remote layer added and rendered", pixel(page, 1000, 450) not in ((255, 255, 255), LAND), f"pixel(1000,450)={pixel(page, 1000, 450)}")
                page.screenshot(path=str(shots / "qgis-wasm-remote-layer.png"))
            # Settings → Options… : QDialog::exec() nested event loop (JSPI) in its own Qt window
            # (the main window has no Qt title bar: the menu bar starts at the top of the page)
            page.mouse.click(269, 11); page.wait_for_timeout(1200)
            page.screenshot(path=str(shots / "qgis-wasm-settings-menu.png"))
            page.mouse.click(300, 176); page.wait_for_timeout(5000)
            check("modal Options dialog opened (nested event loop)", page.evaluate(CANVASES) >= 3, f"canvases={page.evaluate(CANVASES)}")
            page.screenshot(path=str(shots / "qgis-wasm-options-dialog.png"))
            page.keyboard.press("Escape"); page.wait_for_timeout(2000)
            check("dialog closed, application responsive", page.evaluate(CANVASES) == 2 or page.evaluate(CANVASES) == 1, f"canvases={page.evaluate(CANVASES)}")
            if args.keep:
                print("browser kept open; Ctrl-C to end"); page.wait_for_timeout(3600_000)
            browser.close()
    finally:
        server.terminate()
    errs = [c for c in console if c.startswith("[error]")]
    (shots / "console.log").write_text("\n".join(console + failures))
    print(f"console messages: {len(console)}, errors: {len(errs)}, page errors: {len(failures)}")
    for l in (console if args.verbose else errs + failures)[:60]: print("  ", l[:300])
    ok = all(r[1] for r in results) and not failures
    print("OK" if ok else "FAILED")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
