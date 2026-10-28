"""
Bridge between the PyQGIS compatibility layer and the QGIS desktop running in the browser.

Python runs in Pyodide on the page; QGIS runs in the Qt/WebAssembly module. Every QGIS operation is a tool of
QgsWasmBridge reached through `window.qgis.call(tool, params)` (a Promise). PyQGIS code is synchronous, so the
Promise is awaited synchronously with Pyodide's JSPI based `run_sync` — which only works when the Python code
was entered through `pyodide.runPythonAsync()` (the runtime, web/shell/pyqgis.js, always enters that way: plugin
loading, event dispatch, action callbacks, python_run).
"""
import json
import sys

try:
    import js  # type: ignore
    from pyodide.ffi import JsProxy, create_proxy, run_sync, to_js  # type: ignore

    IN_PYODIDE = True
except Exception:  # pragma: no cover - plain CPython (unit tests / linting)
    js = None
    JsProxy = ()
    IN_PYODIDE = False

    def create_proxy(fn):
        return fn

    def to_js(obj, **_kw):
        return obj

    def run_sync(x):
        return x


class QgsWasmBridgeError(RuntimeError):
    """A QGIS tool reported an error (its message is the tool's error text)."""


def _py(value):
    if IN_PYODIDE and isinstance(value, JsProxy):
        try:
            return value.to_py()
        except Exception:
            return value
    return value


def _js(obj):
    if not IN_PYODIDE:
        return obj
    return to_js(obj, dict_converter=js.Object.fromEntries, create_pyproxies=False)


def call(tool, params=None, **kwargs):
    """Run a QGIS tool synchronously and return its result as plain Python data."""
    p = dict(params or {})
    p.update({k: v for k, v in kwargs.items() if v is not None})
    if not IN_PYODIDE:
        raise RuntimeError("qgis bridge is only available inside the browser (Pyodide)")
    promise = js.qgis.call(tool, _js(p))
    try:
        result = run_sync(promise)
    except Exception as e:  # noqa: BLE001
        text = str(e)
        if "run_sync" in text or "suspend" in text.lower() or "stack switching" in text.lower():
            raise RuntimeError(
                "qgis bridge: synchronous call outside of a Python entry point. Run plugin code through the runtime "
                "(actions, signals, python_run) or use `await qgis._bridge.call_async(...)` in an async function."
            ) from e
        raise QgsWasmBridgeError(text.split("Error: ")[-1]) from None
    return _py(result)


async def call_async(tool, params=None, **kwargs):
    p = dict(params or {})
    p.update({k: v for k, v in kwargs.items() if v is not None})
    return _py(await js.qgis.call(tool, _js(p)))


def tools():
    return call("tools_list")


def log(message, tag="Python", level="info"):
    text = f"[{tag}] {message}"
    if js is not None:
        getattr(js.console, "warn" if level in ("warning", "critical") else "log")(text)
    else:
        print(text, file=sys.stderr)


# --- events ---------------------------------------------------------------------------------------------------
# JavaScript forwards every QGIS event (layers.added, project.read, action, …) through pyodide.runPythonAsync()
# into _dispatch_event(), so handlers may call the bridge synchronously.
_HANDLERS = {}


def subscribe(event, handler):
    _HANDLERS.setdefault(event, []).append(handler)
    return lambda: unsubscribe(event, handler)


def unsubscribe(event, handler):
    try:
        _HANDLERS.get(event, []).remove(handler)
    except ValueError:
        pass


def _dispatch_event(event, payload_json):
    try:
        payload = json.loads(payload_json) if isinstance(payload_json, str) else _py(payload_json)
    except Exception:  # noqa: BLE001
        payload = {}
    for handler in list(_HANDLERS.get(event, [])) + list(_HANDLERS.get("*", [])):
        try:
            handler(payload) if handler in _HANDLERS.get(event, []) else handler(event, payload)
        except Exception as e:  # noqa: BLE001
            import traceback

            log(f"event handler for {event} failed: {e}\n{traceback.format_exc()}", "Python", "critical")


# --- paths ----------------------------------------------------------------------------------------------------
# A plugin package lives at /plugins/<id> in Pyodide's filesystem (so `os.path.dirname(__file__)` works). The runtime
# mirrors the same files into QGIS' virtual filesystem so QGIS can read icons and data shipped with the plugin.
QGIS_PLUGIN_ROOT = "/home/web_user/python-plugins"


def qgis_path(path):
    """Translate a Pyodide filesystem path of a plugin resource to the equivalent QGIS (Emscripten) path."""
    if isinstance(path, str) and path.startswith("/plugins/"):
        return QGIS_PLUGIN_ROOT + path[len("/plugins") :]
    return path
