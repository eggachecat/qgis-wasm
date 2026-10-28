# -*- coding: utf-8 -*-
"""Hello PyQGIS — a plain PyQGIS style plugin that runs in QGIS Desktop in the browser (qgis-wasm)."""


def classFactory(iface):
    from .hello_pyqgis import HelloPyQgis

    return HelloPyQgis(iface)
