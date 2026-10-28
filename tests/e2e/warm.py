#!/usr/bin/env python3
"""Cold vs warm start of the QGIS WebAssembly page in the same browser profile.

Load 1 (empty profile): everything downloads. Load 2 (same profile, new browser process): qgis.wasm / qgis.data /
qgis.js must come back as 304 revalidations (serve.mjs sends Cache-Control: no-cache + ETag; deployments must keep
that) and the main window must appear faster, because Chrome reuses the compiled machine code it stored next to the
cached qgis.wasm (code caching only works for instantiateStreaming responses with Content-Type: application/wasm and
only when the response fits the HTTP cache, which is why the bundle is served pre-compressed).

The cold number is dominated by the disk the profile lives on (Chrome writes ~50 MB of profile + caches on a first visit):
1.4 s with the profile on tmpfs, 8–13 s on a slow ext4 disk; wasm compilation itself is about a second on 32 cores.
The warm number is ~1.0 s wherever the profile is. --profile picks the directory (default: a fresh one under $TMPDIR).

  python3 tests/e2e/warm.py [--timeout 300] [--page index.html]
"""
import argparse, os, shutil, subprocess, sys, time, pathlib, json, socket, tempfile
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
CANVASES = "document.querySelector('#qt-shadow-container')?.shadowRoot?.querySelectorAll('canvas').length || 0"
BUNDLE = ("qgis.js", "qgis.wasm", "qgis.data")

def listening(port):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) == 0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(ROOT / "build/qgis/output/bin"))
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--page", default="index.html")
    ap.add_argument("--profile", default="", help="browser profile directory (default: a fresh temporary one)")
    args = ap.parse_args()

    server = None
    if not listening(args.port):
        server = subprocess.Popen(["node", str(ROOT / "scripts/serve.mjs"), "--port", str(args.port), "--dir", os.path.relpath(args.dir, ROOT)],
                                  cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        time.sleep(1.0)
    profile = args.profile or tempfile.mkdtemp(prefix="qgis-wasm-profile-")
    base = f"http://127.0.0.1:{args.port}"
    results, runs = [], []
    def check(name, ok, detail=""):
        results.append((name, ok, detail)); print(("  ✓ " if ok else "  ✗ ") + name + (f" — {detail}" if detail else ""))

    def load(label):
        net, errors = {}, []
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(profile, executable_path=CHROME, headless=True, viewport={"width": 1600, "height": 950}, args=[
                "--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"])
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            t0 = time.time()
            def on_response(r):
                name = r.url.replace(f"{base}/", "")
                if name in BUNDLE:
                    net[name] = {"status": r.status, "encoding": r.headers.get("content-encoding"), "type": r.headers.get("content-type"),
                                 "cache_control": r.headers.get("cache-control"), "etag": r.headers.get("etag"), "at": round(time.time() - t0, 1)}
            page.on("response", on_response)
            page.goto(f"{base}/{args.page}", wait_until="domcontentloaded")
            page.wait_for_function(f"() => ({CANVASES}) > 0 || window.qgisStatus === 'exited'", timeout=args.timeout * 1000)
            window = round(time.time() - t0, 1)
            status = page.evaluate("window.qgisStatus")
            ls = page.evaluate("() => window.qgisLoadStats || null")  # the shell's loading page: download done → module loaded = compile + start
            # the page records when the module's main() ran and when the first Qt window appeared
            # Resource Timing tells cache hits apart from downloads: a revalidated (304) resource transfers only its
            # headers, so transferSize is far below encodedBodySize; Playwright reports such responses as 200.
            wire = page.evaluate("""(() => { const out = {}; for (const e of performance.getEntriesByType('resource')) {
                if (!/\\/(qgis\\.js|qgis\\.wasm|qgis\\.data)$/.test(e.name)) continue;  // one file may have several entries (script tag + pthread worker)
                const k = e.name.split('/').pop(), o = out[k] || (out[k] = { transfer: 0, body: 0, entries: 0 });
                o.transfer = Math.max(o.transfer, e.transferSize); o.body = Math.max(o.body, e.encodedBodySize); o.entries++; }
                return out; })()""")
            ctx.close()
        for k, v in wire.items():
            if k in net: net[k]["transfer"] = v["transfer"]; net[k]["body"] = v["body"]; net[k]["from_cache"] = 0 < v["body"] and v["transfer"] < v["body"]
        compile_ms = round(ls["loadedAt"] - ls["downloadDoneAt"]) if ls and ls.get("loadedAt") and ls.get("downloadDoneAt") else None
        run = {"label": label, "window_s": window, "status": status, "net": net, "errors": errors, "compile_ms": compile_ms}
        runs.append(run)
        print(f"  {label}: main window after {window}s; compile+start {compile_ms} ms; " + ", ".join(f"{k} {v['status']}" + (f" {v['encoding']}" if v.get("encoding") else "") + f" {v.get('transfer', '?')}/{v.get('body', '?')} B @{v['at']}s" for k, v in net.items()))
        return run

    try:
        cold = load("cold (empty profile)")
        check("cold start: bundle downloaded, main window created", cold["status"] == "loaded" and all(cold["net"].get(n, {}).get("status") == 200 and not cold["net"][n].get("from_cache") for n in BUNDLE),
              f"{cold['window_s']}s, wasm {cold['net'].get('qgis.wasm', {}).get('encoding') or 'identity'} {cold['net'].get('qgis.wasm', {}).get('type')}")
        check("bundle is revalidated, not expired: Cache-Control: no-cache + ETag on every file",
              all(cold["net"].get(n, {}).get("cache_control") == "no-cache" and cold["net"].get(n, {}).get("etag") for n in BUNDLE),
              json.dumps({n: cold["net"].get(n, {}).get("etag") for n in BUNDLE}))
        warm = load("warm (same profile, new browser)")
        cached = {n: warm["net"].get(n, {}).get("from_cache") for n in BUNDLE}
        check("warm start: qgis.wasm / qgis.data / qgis.js served from the browser cache (only headers on the wire)",
              all(cached.values()), ", ".join(f"{n} {warm['net'].get(n, {}).get('transfer', '?')} B of {warm['net'].get(n, {}).get('body', '?')}" for n in BUNDLE))
        check("warm start is faster (compiled wasm reused)", warm["status"] == "loaded" and warm["window_s"] < cold["window_s"],
              f"{cold['window_s']}s → {warm['window_s']}s; download done → module loaded {cold['compile_ms']} → {warm['compile_ms']} ms")
        for r in runs:
            for e in r["errors"][:5]: print(f"    [{r['label']}] {e[:200]}")
    finally:
        if server: server.terminate()
        if not args.profile: shutil.rmtree(profile, ignore_errors=True)
    ok = all(r[1] for r in results)
    print("OK" if ok else "FAILED")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
