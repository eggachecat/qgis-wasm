#!/usr/bin/env python3
"""Load the QGIS wasm page, wait for the main window, then evaluate JS snippets (one per --js) and print results.
Also usable for scripted screenshots: --click x,y --key Escape --wait ms --shot name.png (in order given)."""
import argparse, os, subprocess, sys, time, pathlib, json
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parents[2]
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(ROOT / "build/qgis/output/bin")); ap.add_argument("--port", type=int, default=8124)
    ap.add_argument("--page", default="index.html"); ap.add_argument("--timeout", type=int, default=120)
    ap.add_argument("--settle", type=int, default=8)
    ap.add_argument("steps", nargs="*", help="js:<code> | click:x,y | dblclick:x,y | key:<Key> | type:<text> | wait:<ms> | shot:<file> | move:x,y")
    args = ap.parse_args()
    server = subprocess.Popen(["node", str(ROOT / "scripts/serve.mjs"), "--port", str(args.port), "--dir", os.path.relpath(args.dir, ROOT)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    time.sleep(1.0); console = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME, headless=True, args=["--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"])
            page = browser.new_context(viewport={"width": 1600, "height": 950}).new_page()
            page.on("console", lambda m: console.append(f"[{m.type}] {m.text}"))
            page.goto(f"http://127.0.0.1:{args.port}/{args.page}", wait_until="domcontentloaded")
            page.wait_for_function("() => (document.querySelector('#qt-shadow-container')?.shadowRoot?.querySelectorAll('canvas').length || 0) > 0 || window.qgisStatus === 'exited'", timeout=args.timeout * 1000)
            page.wait_for_timeout(args.settle * 1000)
            shots = ROOT / "docs/screenshots"; shots.mkdir(parents=True, exist_ok=True)
            for step in args.steps:
                kind, _, arg = step.partition(":")
                if kind == "js": print(f"js> {arg[:80]}\n", json.dumps(page.evaluate(arg), ensure_ascii=False, default=str)[:3000])
                elif kind in ("click", "dblclick", "move"):
                    x, y = (int(v) for v in arg.split(",")); page.mouse.move(x, y)
                    if kind == "click": page.mouse.click(x, y)
                    elif kind == "dblclick": page.mouse.dblclick(x, y)
                elif kind == "key": page.keyboard.press(arg)
                elif kind == "wheel":
                    dx, dy = (int(v) for v in arg.split(",")); page.mouse.wheel(dx, dy)
                elif kind == "type": page.keyboard.type(arg, delay=20)
                elif kind == "wait": page.wait_for_timeout(int(arg))
                elif kind == "viewport":
                    w, h = (int(v) for v in arg.split(",")); page.set_viewport_size({"width": w, "height": h})
                elif kind == "shot": page.screenshot(path=str(shots / arg)); print("shot", shots / arg)
                else: print("unknown step", step)
            browser.close()
    finally:
        server.terminate()
    (ROOT / "docs/screenshots/console.log").write_text("\n".join(console))
    print(f"console messages: {len(console)}")
if __name__ == "__main__":
    main()
