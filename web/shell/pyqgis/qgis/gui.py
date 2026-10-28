"""qgis.gui — QgisInterface, QgsMapCanvas, QgsMessageBar (the real QGIS widgets, driven through the bridge)."""
from . import _bridge
from .core import Qgis, QgsCoordinateReferenceSystem, QgsMapLayer, QgsPointXY, QgsProject, QgsRasterLayer, QgsRectangle, QgsVectorLayer, _level_name
from .PyQt.QtCore import QObject, pyqtSignal
from .PyQt.QtGui import QAction
from .PyQt.QtWidgets import QMainWindow, QMenu, QToolBar


class QgsMessageBar(QObject):
    def pushMessage(self, *args, **kwargs):
        # pushMessage(text, level=Info, duration=-1) | pushMessage(title, text, level=Info, duration=-1)
        args = list(args)
        level = kwargs.get("level", Qgis.Info)
        duration = kwargs.get("duration", -1)
        if len(args) >= 2 and isinstance(args[1], str):
            title, text = args[0], args[1]
            rest = args[2:]
        else:
            title, text = "", args[0] if args else kwargs.get("text", "")
            rest = args[1:]
        if rest:
            level = rest[0]
        if len(rest) > 1:
            duration = rest[1]
        _bridge.call("ui_message", title=str(title), text=str(text), level=_level_name(level), duration=int(duration) if duration is not None and int(duration) > 0 else None)

    def pushInfo(self, title, text):
        self.pushMessage(title, text, Qgis.Info)

    def pushSuccess(self, title, text):
        self.pushMessage(title, text, Qgis.Success)

    def pushWarning(self, title, text):
        self.pushMessage(title, text, Qgis.Warning)

    def pushCritical(self, title, text):
        self.pushMessage(title, text, Qgis.Critical)

    def clearWidgets(self):
        pass

    def popWidget(self, *a):
        return True

    def createMessage(self, *a, **k):
        return None

    def pushWidget(self, *a, **k):
        pass

    def pushItem(self, *a, **k):
        pass


class QgsMapSettings:
    def destinationCrs(self):
        return QgsProject.instance().crs()

    def extent(self):
        return QgsMapCanvas.instance().extent()

    def outputSize(self):
        from .PyQt.QtCore import QSize

        e = _bridge.call("canvas_extent")
        return QSize(int(e.get("width", 0)), int(e.get("height", 0)))

    def scale(self):
        return QgsMapCanvas.instance().scale()

    def layers(self):
        return list(QgsProject.instance().mapLayers().values())


class QgsMapCanvas(QObject):
    extentsChanged = pyqtSignal()
    scaleChanged = pyqtSignal(float)
    mapCanvasRefreshed = pyqtSignal()
    renderComplete = pyqtSignal(object)
    renderStarting = pyqtSignal()
    layersChanged = pyqtSignal()
    destinationCrsChanged = pyqtSignal()
    xyCoordinates = pyqtSignal(object)
    mapToolSet = pyqtSignal(object, object)

    _instance = None

    @classmethod
    def instance(cls):
        if cls._instance is None:
            cls._instance = cls()
            _bridge.subscribe("canvas.extent", lambda p: cls._instance.extentsChanged.emit())
            _bridge.subscribe("canvas.refreshed", lambda p: (cls._instance.mapCanvasRefreshed.emit(), cls._instance.renderComplete.emit(None)))
        return cls._instance

    def extent(self):
        return QgsRectangle(_bridge.call("canvas_extent"))

    def fullExtent(self):
        rect = None
        for l in QgsProject.instance().mapLayers().values():
            e = l.extent()
            if rect is None:
                rect = e
            else:
                rect.combineExtentWith(e)
        return rect or QgsRectangle()

    def setExtent(self, rect, magnified=False):
        _bridge.call("canvas_set_extent", xmin=rect.xMinimum(), ymin=rect.yMinimum(), xmax=rect.xMaximum(), ymax=rect.yMaximum())

    def zoomToFullExtent(self):
        _bridge.call("canvas_zoom_full")

    def zoomToFeatureExtent(self, rect):
        self.setExtent(rect)

    def zoomToSelected(self, layer=None):
        layers = [layer] if layer is not None else [l for l in QgsProject.instance().mapLayers().values() if isinstance(l, QgsVectorLayer)]
        rect = None
        for l in layers:
            if not isinstance(l, QgsVectorLayer) or l.selectedFeatureCount() == 0:
                continue
            b = l.boundingBoxOfSelected()
            if l.crs() != self.mapSettings().destinationCrs():
                from .core import QgsCoordinateTransform

                b = QgsCoordinateTransform(l.crs(), self.mapSettings().destinationCrs()).transformBoundingBox(b)
            rect = b if rect is None else (rect.combineExtentWith(b) or rect)
        if rect is not None:
            if rect.isEmpty():
                rect.grow(0.5)
            else:
                rect.scale(1.1)
            self.setExtent(rect)

    def zoomScale(self, scale):
        current = self.scale()
        if current:
            e = self.extent()
            e.scale(scale / current)
            self.setExtent(e)

    def zoomIn(self):
        e = self.extent()
        e.scale(0.5)
        self.setExtent(e)

    def zoomOut(self):
        e = self.extent()
        e.scale(2.0)
        self.setExtent(e)

    def setCenter(self, center):
        e = self.extent()
        w, h = e.width(), e.height()
        self.setExtent(QgsRectangle(center.x() - w / 2, center.y() - h / 2, center.x() + w / 2, center.y() + h / 2))

    def center(self):
        return self.extent().center()

    def scale(self):
        return float(_bridge.call("canvas_extent").get("scale", 0))

    def refresh(self):
        _bridge.call("canvas_refresh")

    def refreshAllLayers(self):
        _bridge.call("canvas_refresh")

    def redrawAllLayers(self):
        _bridge.call("canvas_refresh")

    def mapSettings(self):
        return QgsMapSettings()

    def layers(self):
        return list(QgsProject.instance().mapLayers().values())

    def layerCount(self):
        return QgsProject.instance().count()

    def currentLayer(self):
        layers = list(QgsProject.instance().mapLayers().values())
        return layers[0] if layers else None

    def setDestinationCrs(self, crs):
        QgsProject.instance().setCrs(crs)
        self.destinationCrsChanged.emit()

    def saveAsImage(self, fileName, pixmap=None, format="PNG"):
        _bridge.call("canvas_export_image", path=fileName)

    def setMapTool(self, tool, clean=False):
        raise NotImplementedError("Custom map tools (QgsMapTool) need C++ in the browser QGIS; use the built-in tools or a C++ plugin (docs/03).")

    def unsetMapTool(self, tool):
        pass

    def mapTool(self):
        return None

    def setSelectionColor(self, c):
        pass

    def freeze(self, frozen=True):
        pass

    def isFrozen(self):
        return False

    def waitWhileRendering(self):
        pass

    def width(self):
        return int(_bridge.call("canvas_extent").get("width", 0))

    def height(self):
        return int(_bridge.call("canvas_extent").get("height", 0))


class QgsMapTool(QObject):
    def __init__(self, canvas=None):
        super().__init__()
        raise NotImplementedError("QgsMapTool subclasses cannot run in the browser QGIS (no Python inside the Qt event loop); see docs/03.")


QgsMapToolEmitPoint = QgsMapTool
QgsMapToolIdentify = QgsMapTool
QgsMapToolPan = QgsMapTool
QgsMapToolZoom = QgsMapTool


class _LayerTreeView(QObject):
    currentLayerChanged = pyqtSignal(object)

    def currentLayer(self):
        return QgsMapCanvas.instance().currentLayer()

    def setCurrentLayer(self, layer):
        pass

    def selectedLayers(self):
        l = self.currentLayer()
        return [l] if l else []

    def refreshLayerSymbology(self, layer_id):
        _bridge.call("canvas_refresh")


class QgisInterface(QObject):
    """The `iface` object plugins receive. Same method names as PyQGIS; the menus/toolbars/canvas are the real ones."""

    currentLayerChanged = pyqtSignal(object)
    projectRead = pyqtSignal()
    newProjectCreated = pyqtSignal()
    layerSavedAs = pyqtSignal(object, str)
    initializationCompleted = pyqtSignal()

    def __init__(self, plugin_id="python"):
        super().__init__()
        self._plugin_id = plugin_id
        self._canvas = QgsMapCanvas.instance()
        self._message_bar = QgsMessageBar()
        self._main_window = QMainWindow()
        self._layer_tree_view = _LayerTreeView()
        self._actions = []
        _bridge.subscribe("project.read", lambda p: self.projectRead.emit())
        _bridge.subscribe("project.cleared", lambda p: self.newProjectCreated.emit())

    # --- core objects
    def mapCanvas(self):
        return self._canvas

    def mapCanvases(self):
        return [self._canvas]

    def messageBar(self):
        return self._message_bar

    def mainWindow(self):
        return self._main_window

    def layerTreeView(self):
        return self._layer_tree_view

    def layerTreeCanvasBridge(self):
        return None

    def statusBarIface(self):
        return self._main_window.statusBar()

    def pluginMenu(self):
        return QMenu("Plugins")

    def activeLayer(self):
        return self._canvas.currentLayer()

    def setActiveLayer(self, layer):
        return True

    # --- layers & projects
    def addVectorLayer(self, vectorLayerPath, baseName="", providerKey="ogr"):
        layer = QgsVectorLayer(vectorLayerPath, baseName, providerKey)
        return QgsProject.instance().addMapLayer(layer)

    def addRasterLayer(self, rasterLayerPath, baseName="", providerKey="gdal"):
        layer = QgsRasterLayer(rasterLayerPath, baseName, providerKey)
        return QgsProject.instance().addMapLayer(layer)

    def addProject(self, project):
        _bridge.call("project_open", path=project)
        return True

    def newProject(self, promptToSaveFlag=False):
        _bridge.call("project_new")
        return True

    def zoomFull(self):
        self._canvas.zoomToFullExtent()

    def zoomToActiveLayer(self):
        l = self.activeLayer()
        if l is not None:
            _bridge.call("layers_zoom_to", layer=l.id())

    def zoomToPrevious(self):
        pass

    def zoomToNext(self):
        pass

    def showAttributeTable(self, layer, filterExpression=""):
        _bridge.log("showAttributeTable: open it from the layer's context menu in QGIS", "Python", "info")
        return None

    def showLayerProperties(self, layer, page=""):
        _bridge.log("showLayerProperties: open it from the layer's context menu in QGIS", "Python", "info")

    # --- menus & toolbars (become entries of the real QGIS Plugins menu / plugin toolbar)
    def addPluginToMenu(self, name, action):
        action._ensure_registered(menu=name.replace("&", "") if isinstance(name, str) else "Python Plugins")
        if action not in self._actions:
            self._actions.append(action)

    def removePluginMenu(self, name, action):
        action._unregister()
        if action in self._actions:
            self._actions.remove(action)

    def addToolBarIcon(self, action):
        action._ensure_registered(toolbar=True)
        if action not in self._actions:
            self._actions.append(action)
        return 0

    def removeToolBarIcon(self, action):
        action._in_toolbar = False
        if action._bridge_id is not None and action._menu is not None:
            action._sync()  # keep the menu entry, drop the button
        else:
            action._unregister()

    def addToolBar(self, name):
        return QToolBar(name if isinstance(name, str) else "Python Plugins")

    def addToolBarWidget(self, widget):
        return None

    def addPluginToVectorMenu(self, name, action):
        self.addPluginToMenu(name, action)

    def addPluginToRasterMenu(self, name, action):
        self.addPluginToMenu(name, action)

    def addPluginToDatabaseMenu(self, name, action):
        self.addPluginToMenu(name, action)

    def addPluginToWebMenu(self, name, action):
        self.addPluginToMenu(name, action)

    def addPluginToMeshMenu(self, name, action):
        self.addPluginToMenu(name, action)

    removePluginVectorMenu = removePluginRasterMenu = removePluginDatabaseMenu = removePluginWebMenu = removePluginMeshMenu = removePluginMenu

    def vectorMenu(self):
        return QMenu("Vector")

    def rasterMenu(self):
        return QMenu("Raster")

    def webMenu(self):
        return QMenu("Web")

    def addDockWidget(self, area, dockwidget):
        raise NotImplementedError("iface.addDockWidget: Python cannot create Qt dock widgets in the browser QGIS; use a web plugin HTML panel (docs/03).")

    def removeDockWidget(self, dockwidget):
        pass

    def registerMainWindowAction(self, action, defaultShortcut=""):
        action._ensure_registered(menu="Python Plugins")
        return True

    def unregisterMainWindowAction(self, action):
        action._unregister()
        return True

    def openURL(self, url, useQgisDocDirectory=True):
        _bridge.js.window.open(url, "_blank")

    def _dispose(self):
        for a in list(self._actions):
            a._unregister()
        self._actions = []

    # --- misc PyQGIS surface
    def actionToggleEditing(self):
        return QAction("Toggle Editing")

    def actionSaveProject(self):
        a = QAction("Save Project")
        a.triggered.connect(lambda *_: _bridge.call("project_save"))
        return a

    def defaultStyleSheetOptions(self):
        return {}

    def iconSize(self, dockedToolbar=False):
        from .PyQt.QtCore import QSize

        return QSize(24, 24)
