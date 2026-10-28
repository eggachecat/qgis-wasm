# -*- coding: utf-8 -*-
"""Hello PyQGIS — standard Plugin-Builder style code, unchanged in spirit from a desktop plugin."""
import os

from qgis.core import Qgis, QgsExpression, QgsMessageLog, QgsProject, QgsVectorLayer
from qgis.PyQt.QtCore import QCoreApplication
from qgis.PyQt.QtGui import QIcon
from qgis.PyQt.QtWidgets import QAction, QInputDialog
import processing

DEMO_GPKG = "/qgis/share/qgis/resources/data/world_map.gpkg"


class HelloPyQgis:
    def __init__(self, iface):
        self.iface = iface
        self.plugin_dir = os.path.dirname(__file__)
        self.actions = []
        self.menu = self.tr("&Hello PyQGIS")

    def tr(self, message):
        return QCoreApplication.translate("HelloPyQgis", message)

    def add_action(self, icon_path, text, callback, add_to_toolbar=True):
        action = QAction(QIcon(icon_path) if icon_path else QIcon(), text, self.iface.mainWindow())
        action.triggered.connect(callback)
        if add_to_toolbar:
            self.iface.addToolBarIcon(action)
        self.iface.addPluginToMenu(self.menu, action)
        self.actions.append(action)
        return action

    def initGui(self):
        icon = os.path.join(self.plugin_dir, "icon.svg")
        self.add_action(icon, self.tr("Load demo countries (PyQGIS)"), self.load_demo)
        self.add_action(None, self.tr("Layer summary (PyQGIS)"), self.summary, add_to_toolbar=False)
        self.add_action(None, self.tr("Buffer first vector layer… (PyQGIS)"), self.buffer, add_to_toolbar=False)
        QgsMessageLog.logMessage("Hello PyQGIS loaded", "HelloPyQGIS", Qgis.Info)
        QgsProject.instance().layersAdded.connect(lambda layers: QgsMessageLog.logMessage("layers added: " + ", ".join(l.name() for l in layers), "HelloPyQGIS", Qgis.Info))

    def unload(self):
        for action in self.actions:
            self.iface.removePluginMenu(self.menu, action)
            self.iface.removeToolBarIcon(action)
        self.actions = []

    # ---- actions
    def load_demo(self):
        layer = QgsVectorLayer(DEMO_GPKG + "|layername=countries", "Countries (PyQGIS)", "ogr")
        QgsProject.instance().addMapLayer(layer)
        if not layer.isValid():
            self.iface.messageBar().pushMessage("Hello PyQGIS", self.tr("Could not load the demo layer"), level=Qgis.Critical, duration=8)
            return
        canvas = self.iface.mapCanvas()
        canvas.setExtent(layer.extent())
        canvas.refresh()
        total = QgsExpression("aggregate('{}', 'count', 1)".format(layer.name().replace("'", "''")))
        self.iface.messageBar().pushMessage("Hello PyQGIS", self.tr("Loaded {} with {} features").format(layer.name(), layer.featureCount()), level=Qgis.Success, duration=6)
        return layer

    def summary(self):
        layers = QgsProject.instance().mapLayers().values()
        text = "; ".join("{} ({}{})".format(l.name(), l.providerType(), ", %d features" % l.featureCount() if isinstance(l, QgsVectorLayer) else "") for l in layers) or self.tr("no layers")
        self.iface.messageBar().pushMessage("Hello PyQGIS", text, level=Qgis.Info, duration=8)
        return text

    def buffer(self, distance=None):
        vectors = [l for l in QgsProject.instance().mapLayers().values() if isinstance(l, QgsVectorLayer)]
        if not vectors:
            self.iface.messageBar().pushMessage("Hello PyQGIS", self.tr("Add a vector layer first"), level=Qgis.Warning, duration=6)
            return None
        layer = vectors[0]
        if distance is None:
            distance, ok = QInputDialog.getDouble(self.iface.mainWindow(), self.tr("Buffer"), self.tr("Distance in layer units"), 1.0, 0.0, 1e9, 3)
            if not ok:
                return None
        result = processing.run("native:buffer", {"INPUT": layer, "DISTANCE": float(distance), "SEGMENTS": 8, "DISSOLVE": False, "OUTPUT": "TEMPORARY_OUTPUT"})
        out = result.get("OUTPUT")
        self.iface.messageBar().pushMessage("Hello PyQGIS", self.tr("Buffered {} → {}").format(layer.name(), out.name() if out is not None else out), level=Qgis.Success, duration=6)
        return out
