#!/usr/bin/env python3
"""End-to-end test of the web agent (web/agent) against a scripted model (tests/mock-llm.mjs), the mock MCP catalogue
and the S3 mock: boot + tool discovery, panel ↔ QGIS layout, the tool loop through assistant_ask (?ask= / MCP path),
skills (import_data), MCP tools, approvals for guarded tools, both model providers, the composer UI, uploads, and the
standalone agent page driving QGIS remotely through scripts/serve.mjs.
  python3 tests/e2e/agent.py [--keep] [--timeout 300]
Starts: scripts/serve.mjs (8123, reused if running), tests/s3-mock.mjs (9123), tests/mock-mcp.mjs (9124), tests/mock-llm.mjs (9125).
Uses the preset web/shell/presets/e2e-agent.json.
"""
import argparse, base64, json, os, pathlib, shutil, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
PORT, S3_PORT, MCP_PORT, LLM_PORT = 8123, 9123, 9124, 9125
CANVAS = "document.querySelector('#qt-shadow-container').shadowRoot.querySelector('canvas')"


def call(page, tool, params=None):
    return page.evaluate("async ([t, p]) => window.qgis.call(t, p)", [tool, params or {}])


def status(page):
    return page.evaluate("() => window.qgisAgent.status()")


def wait_idle(page, timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        st = status(page)
        if not st["busy"]:
            return st
        page.wait_for_timeout(500)
    raise TimeoutError("agent still busy")


def ask(page, text, timeout=90):
    """One scenario = one fresh conversation (the transcript checks look at this turn only)."""
    call(page, "assistant_reset")
    page.wait_for_timeout(300)
    call(page, "assistant_ask", {"text": text})
    page.wait_for_timeout(500)
    return wait_idle(page, timeout)


def tool_names(st):
    return [t["name"] for t in st["transcript"] if t["role"] == "tool"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(ROOT / "build/qgis/output/bin"))
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    os.environ.setdefault("NO_PROXY", "127.0.0.1,localhost")

    seed = pathlib.Path(tempfile.mkdtemp(prefix="qgis-wasm-s3-"))
    (seed / "data").mkdir()
    for f in (ROOT / "tests/data").glob("*.geojson"):
        shutil.copy(f, seed / "data" / f.name)
    err = sys.stderr if args.verbose else subprocess.DEVNULL
    procs = [
        subprocess.Popen(["node", str(ROOT / "scripts/serve.mjs"), "--port", str(PORT), "--dir", os.path.relpath(args.dir, ROOT)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL),
        subprocess.Popen(["node", str(ROOT / "tests/s3-mock.mjs"), "--port", str(S3_PORT), "--bucket", "gis", "--access", "TESTKEY", "--secret", "TESTSECRET", "--seed", str(seed)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=err),
        subprocess.Popen(["node", str(ROOT / "tests/mock-mcp.mjs"), "--port", str(MCP_PORT), "--data", str(ROOT / "tests/data")], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=err),
        subprocess.Popen(["node", str(ROOT / "tests/mock-llm.mjs"), "--port", str(LLM_PORT)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=err),
    ]
    time.sleep(1.5)
    shots = ROOT / "docs/screenshots"; shots.mkdir(parents=True, exist_ok=True)
    console, results = [], []

    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail)); print(("  ✓ " if ok else "  ✗ ") + name + (f" — {detail}" if detail else ""), flush=True)

    base = f"http://127.0.0.1:{PORT}"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME, headless=not args.keep, args=["--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"])
            context = browser.new_context(viewport={"width": 1600, "height": 950})
            page = context.new_page()
            page.on("console", lambda m: console.append(f"[{m.type}] {m.text}"))
            page.on("pageerror", lambda e: console.append(f"[pageerror] {e}"))
            t0 = time.time()
            page.goto(f"{base}/index.html?preset=e2e-agent&open=/qgis/share/demo/world.qgs", wait_until="domcontentloaded")
            page.wait_for_function("() => window.qgisBridgeReady === true", timeout=args.timeout * 1000)
            page.wait_for_function("() => !!window.qgisAgent && window.qgisAgent.hostToolsLoaded", timeout=60000)
            page.wait_for_function("() => document.getElementById('loading').classList.contains('hidden')", timeout=60000)  # the settle hold (loading.js) lifts ≈ 1.6 s after the bridge is up
            deadline = time.time() + 90  # ?open= runs after startup; wait until the demo project is really loaded
            while time.time() < deadline and len(call(page, "layers_list")) < 3:
                page.wait_for_timeout(500)
            check("QGIS started, demo project loaded, agent booted", len(call(page, "layers_list")) == 3, f"{time.time() - t0:.1f}s")

            # ---- boot, discovery, layout
            deadline = time.time() + 60
            while time.time() < deadline and not (all(s["ready"] for s in status(page)["mcpServers"]) and all(not s["error"] for s in status(page)["skills"]) and len(status(page)["skills"]) == 2):
                page.wait_for_timeout(500)
            st = status(page)
            check("agent configured against the mock model", st["configured"] and st["model"] == "mock-model" and st["provider"] == "openai-responses", f"{st['model']} via {st['provider']}")
            check("tools discovered from QGIS, the page, MCP and skills", st["toolsBySource"].get("qgis", 0) >= 35 and st["toolsBySource"].get("shell", 0) >= 5 and st["toolsBySource"].get("mcp", 0) == 2 and st["toolsBySource"].get("skill", 0) == 2, json.dumps(st["toolsBySource"]))
            check("skills loaded with commands", [s["name"] for s in st["skills"]] == ["Import", "Analysis"] and "import" in st["skills"][0]["commands"], json.dumps([(s["name"], s["tools"], s["commands"]) for s in st["skills"]]))
            check("bridge API version matches the agent", st["api"] and st["api"]["ok"], json.dumps(st["api"]))
            # the agent renders inside the page's workspace panel (web/shell/workspace.js); the workspace owns button, header, layout
            check("workspace button present, panel closed (preset ui.openOnStart false), agent embedded in its slot", page.evaluate("() => !!document.querySelector('.ws-fab') && document.querySelector('.ws-root').dataset.open === 'false' && !!document.querySelector('.ws-slot .qa-root[data-embedded=\"true\"]') && !document.querySelector('.qa-fab')"))
            # closed, the card must be inert: a click where it would be goes to QGIS (an embedded panel with its own pointer-events once swallowed the right third of the screen)
            check("closed workspace does not intercept clicks on QGIS", page.evaluate("() => document.elementFromPoint(innerWidth - 200, 300).id === 'qt-shadow-container' && getComputedStyle(document.querySelector('.ws-panel')).visibility === 'hidden'"), page.evaluate("() => document.elementFromPoint(innerWidth - 200, 300).tagName + '#' + document.elementFromPoint(innerWidth - 200, 300).id"))
            BOX = "(() => { const r = document.querySelector('.ws-panel').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom, r.width, r.height, innerWidth, innerHeight]; })()"
            w0 = page.evaluate(f"() => {CANVAS}.width")
            page.click(".ws-fab")
            page.wait_for_timeout(1500)
            w1 = page.evaluate(f"() => {CANVAS}.width")
            right = page.evaluate("() => document.getElementById('screen').style.right")
            box = page.evaluate(f"() => {BOX}")
            check("floating card: QGIS keeps its full width, card on the right with equal 22 px margins top and bottom", w1 == w0 and right == "" and box[0] > box[6] / 2 and round(box[1]) == 22 and round(box[7] - box[3]) == 22 and round(box[6] - box[2]) == 22 and 400 <= box[4] <= 480, f"canvas {w0} → {w1}, screen.right={right!r}, card={[round(v) for v in box[:6]]}")
            check("workspace header: project / share / data menus, the agent's two buttons, close — no pop-out", page.evaluate("() => [...document.querySelectorAll('.ws-tools .ws-tool')].map((b) => b.title)") == ["Project: save, share, open, export", "Share: links, MCP endpoint", "Data sources and cloud storage", "New conversation", "Agent settings", "Debug: web + QGIS logs, timings, memory", "Layout, links, about", "Close"], json.dumps(page.evaluate("() => [...document.querySelectorAll('.ws-tools .ws-tool')].map((b) => b.title)")))
            # move by the header (full-height card: only sideways), resize by the top-left grip; geometry is remembered
            hb = page.evaluate("() => { const r = document.querySelector('.ws-title').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")  # the title: not a button
            page.mouse.move(hb[0], hb[1]); page.mouse.down(); page.mouse.move(hb[0] - 300, hb[1] - 150, steps=6); page.mouse.up()
            gb = page.evaluate("() => { const r = document.querySelector('.ws-grip').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }")
            page.mouse.move(gb[0], gb[1]); page.mouse.down(); page.mouse.move(gb[0] - 100, gb[1] + 80, steps=6); page.mouse.up()
            page.wait_for_timeout(300)
            box2 = page.evaluate(f"() => {BOX}")
            geom = json.loads(page.evaluate("() => localStorage.getItem('qgis-wasm.workspace.geometry') || '{}'"))
            check("card moved by the header and resized by the grip, geometry persisted", abs((box[0] - box2[0]) - 400) <= 3 and round(box2[7] - box2[3]) == 22 and abs((box2[4] - box[4]) - 100) <= 2 and abs((box[5] - box2[5]) - 80) <= 2 and geom.get("x") == 322 and geom.get("w") == round(box2[4]) and geom.get("h") == round(box2[5]), f"card {[round(v) for v in box[:6]]} → {[round(v) for v in box2[:6]]}, geometry={geom}")
            # the docked sidebar is still available (⋯ menu / ui.layout = "dock"): QGIS makes room for it; qgisAgentPanel delegates to the workspace
            page.evaluate("() => window.qgisAgentPanel.setLayout('dock')")
            page.wait_for_timeout(2500)
            w2 = page.evaluate(f"() => {CANVAS}.width")
            right = page.evaluate("() => document.getElementById('screen').style.right")
            check("dock layout shrinks the QGIS screen (no overlap)", w2 <= w0 - 400 and right == f"{round(box2[4])}px", f"canvas {w0} → {w2}, screen.right={right}")
            ext = call(page, "canvas_extent")
            check("map keeps a valid extent after the resize", ext and ext.get("width", 0) > 0 and abs(ext.get("xmin", 1e9)) <= 360, json.dumps(ext)[:120])
            page.evaluate("() => window.qgisAgentPanel.setLayout('float')")
            page.wait_for_timeout(2500)
            w3 = page.evaluate(f"() => {CANVAS}.width")
            check("back to the floating card: QGIS gets its full width back", w3 == w0 and page.evaluate("() => document.getElementById('screen').style.right") == "", f"canvas {w2} → {w3}")

            # ---- tool loop through assistant_ask (the ?ask= / MCP entry)
            st = ask(page, "How many layers are loaded?")
            check("assistant_ask: model called layers_list and answered", tool_names(st) == ["layers_list"] and "3 layers" in st["lastAnswer"], st["lastAnswer"])
            check("panel rendered markdown + tool card", page.evaluate("() => document.querySelector('.qa-msg.assistant .qa-md strong') !== null && document.querySelector('.qa-tool[data-tool=\"layers_list\"] .qa-ok') !== null"))

            # ---- skills + MCP: import through the catalogue
            st = ask(page, "Find the city regions dataset in the internal catalogue and import it")
            names = tool_names(st)
            layers = call(page, "layers_list")
            check("MCP catalogue tool then the import_data skill tool ran", names == ["mcp__catalog__search_datasets", "import_data"], json.dumps(names))
            check("dataset imported and zoomed", any(l["name"] == "City regions" for l in layers) and "Imported" in st["lastAnswer"], st["lastAnswer"])
            page.screenshot(path=str(shots / "qgis-wasm-agent.png"))

            # ---- approvals for guarded tools (preset: project_save needs confirmation)
            call(page, "assistant_reset")
            call(page, "assistant_ask", {"text": "Please save the project"})
            page.wait_for_selector(".qa-confirm", timeout=30000)
            check("guarded tool waits for approval", page.evaluate("() => document.querySelector('.qa-tool[data-tool=\"project_save\"]').textContent.includes('approval')"))
            page.wait_for_timeout(400)  # entrance animation
            vis = page.evaluate("() => { const c = document.querySelector('.qa-confirm').getBoundingClientRect(), p = document.querySelector('.qa-panel').getBoundingClientRect(), i = document.querySelector('.qa-composer').getBoundingClientRect(), t = document.querySelector('.qa-tool[data-tool=\"project_save\"]').getBoundingClientRect(); return { inside: c.top >= p.top && c.bottom <= p.bottom, aboveComposer: Math.abs(c.bottom - i.top) < 2, cardHeight: t.height, text: document.querySelector('.qa-confirm').textContent }; }")
            check("approval bar pinned above the composer, visible regardless of the list; tool card not squashed", vis["inside"] and vis["aboveComposer"] and vis["cardHeight"] > 30 and "project_save" in vis["text"] and "agent-test.qgz" in vis["text"], f"card {vis['cardHeight']:.0f}px · {vis['text'][:80]}")
            page.click(".qa-confirm .qa-btn.primary")
            st = wait_idle(page)
            files = [f["name"] for f in call(page, "files_list", {"path": "/home/web_user"})]
            check("approved: project saved", "agent-test.qgz" in files and "Saved" in st["lastAnswer"], st["lastAnswer"])
            call(page, "assistant_reset")
            call(page, "assistant_ask", {"text": "Please save the project again"})
            page.wait_for_selector(".qa-confirm", timeout=30000)
            page.click(".qa-confirm .qa-btn:not(.primary)")
            st = wait_idle(page)
            check("denied: tool not run, model told", "declined" in st["lastAnswer"] and [t for t in st["transcript"] if t["role"] == "tool"][-1]["error"] != "", st["lastAnswer"][:120])

            # ---- composer UI: slash commands and typing
            page.fill(".qa-input", "/")
            page.wait_for_timeout(200)
            cmds = page.evaluate("() => [...document.querySelectorAll('.qa-cmds[data-open=\"true\"] .qa-cmd b')].map(b => b.textContent)")
            check("slash command menu lists skill commands", "/import" in cmds and "/stats" in cmds, json.dumps(cmds))
            call(page, "assistant_reset")
            page.fill(".qa-input", "Export the map please")
            page.keyboard.press("Enter")
            page.wait_for_timeout(500)
            st = wait_idle(page)
            check("typed message ran a tool with an image result shown inline", "canvas_export_image" in tool_names(st) and page.evaluate("() => document.querySelectorAll('.qa-tool-images img').length") >= 1, st["lastAnswer"][:100])

            # ---- second provider (Chat Completions) against the same mock
            page.evaluate("() => window.qgisAgent.updateConfig({ provider: 'openai-chat' }, { persist: false })")
            page.wait_for_timeout(1000)
            st = ask(page, "How many layers are loaded now?")
            check("openai-chat provider: tool loop works", status(page)["provider"] == "openai-chat" and tool_names(st)[-1:] == ["layers_list"] and "4 layers" in st["lastAnswer"], st["lastAnswer"])
            page.evaluate("() => window.qgisAgent.updateConfig({ provider: 'openai-responses' }, { persist: false })")

            # ---- user customisation persists in the browser
            page.evaluate("() => window.qgisAgent.updateConfig({ instructions: 'Always answer briefly.', skillsExtra: [] })")
            saved = json.loads(page.evaluate("() => localStorage.getItem('qgis-wasm.agent')"))
            check("user settings stored in localStorage, preset untouched", saved.get("instructions") == "Always answer briefly." and status(page)["skills"][0]["name"] == "Import", json.dumps(saved))

            # ---- upload + skill tool used directly (no model)
            geojson = json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"n": 1}, "geometry": {"type": "Point", "coordinates": [10, 50]}}]})
            up = call(page, "upload", {"name": "dropped.geojson", "base64": base64.b64encode(geojson.encode()).decode()})
            imp = page.evaluate("async (path) => window.qgisAgent.registry.get('import_data').run({ source: path })", up["path"])
            check("uploaded file imported by the skill tool", up["path"] == "/home/web_user/uploads/dropped.geojson" and imp["layers"][0]["features"] == 1, json.dumps(imp)[:160])
            stats = page.evaluate("async () => window.qgisAgent.registry.get('layer_statistics').run({ layer: 'City regions' })")
            check("layer_statistics skill tool", stats["features"] == 10 and len(stats["fields"]) > 0, json.dumps({k: v.get('type') for k, v in stats['fields'].items()})[:160])

            # ---- standalone agent page driving this QGIS through the server
            client = page.evaluate("() => window.qgisAgentClientId")
            page2 = context.new_page()
            page2.on("console", lambda m: console.append(f"[p2 {m.type}] {m.text}"))
            page2.goto(f"{base}/agent/agent.html?qgis={base}&preset=e2e-agent&client={client}", wait_until="domcontentloaded")
            page2.wait_for_function("() => !!window.qgisAgent && window.qgisAgent.hostToolsLoaded", timeout=60000)
            st2 = page2.evaluate("() => window.qgisAgent.status()")
            check("standalone page sees QGIS tools remotely", st2["host"] == "remote" and st2["tools"] >= 45, json.dumps(st2["toolsBySource"]))
            page2.evaluate("() => window.qgisAgent.ask('How many layers are loaded?')")
            deadline = time.time() + 60
            while time.time() < deadline and page2.evaluate("() => window.qgisAgent.busy"):
                page2.wait_for_timeout(500)
            st2 = page2.evaluate("() => window.qgisAgent.status()")
            check("standalone page ran a tool on the remote QGIS and answered", "layers" in st2["lastAnswer"] and tool_names(st2) == ["layers_list"], st2["lastAnswer"])
            page2.screenshot(path=str(shots / "qgis-wasm-agent-standalone.png"))
            page2.close()

            if args.keep:
                print("browser kept open; Ctrl-C to end"); page.wait_for_timeout(3600_000)
            browser.close()
    finally:
        for pr in procs:
            pr.terminate()
        shutil.rmtree(seed, ignore_errors=True)
        (ROOT / "docs/screenshots/agent-console.log").write_text("\n".join(console))
    errors = [c for c in console if c.startswith("[error]") or c.startswith("[pageerror]")]
    print(f"console messages: {len(console)}, errors: {len(errors)}")
    failed = [r for r in results if not r[1]]
    print("FAILED" if failed else "OK", f"({len(results) - len(failed)}/{len(results)})")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
