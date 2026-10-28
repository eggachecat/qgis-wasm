"""qgis.utils — the `iface` global and the plugin registry (mirrors QGIS' qgis/utils.py)."""
import importlib
import sys
import traceback

from . import _bridge

iface = None
plugins = {}
plugin_times = {}
active_plugins = []
available_plugins = []
plugins_metadata_parser = {}
_ifaces = {}


def _get_iface(plugin_id="python"):
    """The shared QgisInterface (one per plugin so that unload() can clean up its menu entries)."""
    global iface
    from .gui import QgisInterface

    if plugin_id not in _ifaces:
        _ifaces[plugin_id] = QgisInterface(plugin_id)
    if iface is None:
        iface = _ifaces[plugin_id]
    return _ifaces[plugin_id]


def pluginMetadata(packageName, fct):
    import configparser

    cp = configparser.ConfigParser(interpolation=None)
    try:
        cp.read(f"/plugins/{packageName}/metadata.txt", encoding="utf-8")
        return cp.get("general", fct)
    except Exception:  # noqa: BLE001
        return "__error__"


def updateAvailablePlugins():
    import os

    global available_plugins
    available_plugins = sorted(d for d in (os.listdir("/plugins") if os.path.isdir("/plugins") else []) if os.path.isfile(f"/plugins/{d}/__init__.py"))
    return available_plugins


def loadPlugin(packageName):
    try:
        importlib.import_module(packageName)
        return True
    except Exception:  # noqa: BLE001
        showException(*sys.exc_info(), msg=f"Could not load plugin {packageName}")
        return False


def startPlugin(packageName):
    if packageName in plugins:
        return False
    import time

    t0 = time.time()
    mod = sys.modules.get(packageName) or importlib.import_module(packageName)
    plugin_iface = _get_iface(packageName)
    try:
        plugins[packageName] = mod.classFactory(plugin_iface)
        plugins[packageName].initGui()
        active_plugins.append(packageName)
        plugin_times[packageName] = f"{(time.time() - t0) * 1000:.0f} ms"
        _bridge.log(f"Python plugin {packageName} loaded", "Python", "info")
        return True
    except Exception:  # noqa: BLE001
        plugins.pop(packageName, None)
        showException(*sys.exc_info(), msg=f"Could not start plugin {packageName}")
        return False


def unloadPlugin(packageName):
    plugin = plugins.pop(packageName, None)
    if plugin is None:
        return False
    try:
        plugin.unload()
    except Exception:  # noqa: BLE001
        showException(*sys.exc_info(), msg=f"Error while unloading plugin {packageName}")
    plugin_iface = _ifaces.get(packageName)
    if plugin_iface is not None:
        plugin_iface._dispose()
    if packageName in active_plugins:
        active_plugins.remove(packageName)
    for k in [k for k in list(sys.modules) if k == packageName or k.startswith(packageName + ".")]:
        del sys.modules[k]
    return True


def reloadPlugin(packageName):
    unloadPlugin(packageName)
    return loadPlugin(packageName) and startPlugin(packageName)


def isPluginLoaded(packageName):
    return packageName in plugins


def showException(type_, value, tb, msg=None, messagebar=True, level=2):
    text = "".join(traceback.format_exception(type_, value, tb))
    _bridge.log(f"{msg or 'Python error'}:\n{text}", "Python", "critical")
    if messagebar:
        try:
            _bridge.call("ui_message", title="Python", text=f"{msg or 'Python error'}: {value}", level="critical", duration=12)
        except Exception:  # noqa: BLE001
            pass


def qgis_excepthook(type_, value, tb):
    showException(type_, value, tb)


sys.excepthook = qgis_excepthook
