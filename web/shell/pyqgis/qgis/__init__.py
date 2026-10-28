"""
`qgis` — PyQGIS compatibility layer for QGIS Desktop running in the browser (qgis-wasm).

This is not PyQGIS (there is no CPython inside the QGIS WebAssembly module): it is a Python API with the
PyQGIS names and semantics that plugins use most, implemented on top of the QGIS control surface
(QgsWasmBridge). See docs/03-插件与迁移指南.md for the supported subset.
"""
from . import _bridge  # noqa: F401

__version__ = "0.1.0"
