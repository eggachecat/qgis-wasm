#!/usr/bin/env python3
"""Pause every Web Worker (pthread) of the QGIS wasm page via raw CDP and print their wasm call stacks
(needs qgis.wasm linked with --profiling-funcs, the default). Also tries the main thread.

  python3 tests/e2e/stacks.py [--page 'index.html?open=...'] [--settle 25] [--frames 30]
"""
import argparse, os, subprocess, sys, time, pathlib, json, urllib.request
from playwright.sync_api import sync_playwright
import websocket  # websocket-client
for _v in ("no_proxy", "NO_PROXY"):
    os.environ[_v] = "127.0.0.1,localhost," + os.environ.get(_v, "")   # corporate proxies must not see DevTools traffic
ROOT = pathlib.Path(__file__).resolve().parents[2]
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
DEVTOOLS_PORT = 9333

def cdp_stack(ws_url, label, frames, sample_ms=1500):
    """Sample the thread with the CPU profiler for a moment and print its dominant call stack
    (works for threads blocked in Atomics.wait, where Debugger.pause never triggers)."""
    ws = websocket.create_connection(ws_url, timeout=5, suppress_origin=True)
    mid = 0
    def send(method, params=None):
        nonlocal mid; mid += 1
        ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        this_id = mid
        end = time.time() + 8
        while time.time() < end:
            try: msg = json.loads(ws.recv())
            except websocket.WebSocketTimeoutException: continue
            if msg.get("id") == this_id: return msg.get("result", {})
        return {}
    send("Profiler.enable"); send("Profiler.setSamplingInterval", {"interval": 500}); send("Profiler.start")
    time.sleep(sample_ms / 1000.0)
    prof = send("Profiler.stop").get("profile")
    ws.close()
    if not prof:
        print(f"[{label}] no profile"); return
    nodes = {n["id"]: n for n in prof["nodes"]}
    parent = {}
    for n in prof["nodes"]:
        for c in n.get("children", []): parent[c] = n["id"]
    from collections import Counter
    counts = Counter(prof.get("samples", []))
    total = sum(counts.values()) or 1
    shown = 0
    for leaf, cnt in counts.most_common(3):
        name = nodes[leaf]["callFrame"].get("functionName") or "(anonymous)"
        if name in ("(idle)", "(program)", "(garbage collector)", "(root)") and cnt / total < 0.95 and shown == 0 and len(counts) > 1:
            continue
        print(f"[{label}] {cnt}/{total} samples in stack:")
        chain = []; cur = leaf
        while cur is not None and len(chain) < frames:
            cf = nodes[cur]["callFrame"]; chain.append(cf.get("functionName") or "(anonymous)"); cur = parent.get(cur)
        for i, fn in enumerate(chain): print(f"   #{i:02d} {fn[:150]}")
        shown += 1
        if shown >= 2: break

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(ROOT / "build/qgis/output/bin")); ap.add_argument("--port", type=int, default=8126)
    ap.add_argument("--page", default="index.html"); ap.add_argument("--settle", type=int, default=25); ap.add_argument("--frames", type=int, default=30)
    args = ap.parse_args()
    server = subprocess.Popen(["node", str(ROOT / "scripts/serve.mjs"), "--port", str(args.port), "--dir", os.path.relpath(args.dir, ROOT)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    time.sleep(1.0)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME, headless=True, args=["--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage", f"--remote-debugging-port={DEVTOOLS_PORT}"])
            ctx = browser.new_context(viewport={"width": 1600, "height": 950})
            page = ctx.new_page()
            page.goto(f"http://127.0.0.1:{args.port}/{args.page}", wait_until="domcontentloaded")
            page.wait_for_function("() => (document.querySelector('#qt-shadow-container')?.shadowRoot?.querySelectorAll('canvas').length || 0) > 0", timeout=180000)
            page.wait_for_timeout(args.settle * 1000)
            targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{DEVTOOLS_PORT}/json/list").read())
            workers = [t for t in targets if t.get("type") == "worker"]
            pages = [t for t in targets if t.get("type") == "page" and "index.html" in t.get("url", "")]
            print(f"targets: {len(workers)} workers, {len(pages)} page(s)")
            for i, t in enumerate(workers):
                try: cdp_stack(t["webSocketDebuggerUrl"], f"worker{i}", args.frames)
                except Exception as e: print(f"[worker{i}] error: {e}")
            for t in pages:
                try: cdp_stack(t["webSocketDebuggerUrl"], "main", args.frames)
                except Exception as e: print(f"[main] error: {e}")
            browser.close()
    finally:
        server.terminate()
if __name__ == "__main__":
    main()
