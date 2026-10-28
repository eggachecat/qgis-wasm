#!/usr/bin/env python3
"""Create web/demo/world.qgs with the system PyQGIS: three styled layers from QGIS' bundled world_map.gpkg.
The data source paths are rewritten to the location inside the WebAssembly virtual filesystem."""
import os, re, sys, pathlib
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from qgis.core import *
from qgis.PyQt.QtGui import QColor, QFont
from qgis.PyQt.QtCore import QSize
ROOT = pathlib.Path(__file__).resolve().parents[1]
GPKG = ROOT / "external/QGIS/resources/data/world_map.gpkg"
WASM_GPKG = "/qgis/share/qgis/resources/data/world_map.gpkg"
OUT = ROOT / "web/demo/world.qgs"

QgsApplication.setPrefixPath("/usr", True)
app = QgsApplication([], False); app.initQgis()
p = QgsProject.instance(); p.setTitle("World (QGIS WebAssembly demo)")
p.setCrs(QgsCoordinateReferenceSystem("EPSG:4326"))

def layer(name, title):
    l = QgsVectorLayer(f"{GPKG}|layername={name}", title, "ogr"); assert l.isValid(), name; return l

states = layer("states_provinces", "States / provinces")
sym = QgsFillSymbol.createSimple({"color": "245,240,225,255", "outline_color": "200,190,170,255", "outline_width": "0.15"})
states.setRenderer(QgsSingleSymbolRenderer(sym)); states.setScaleBasedVisibility(True); states.setMaximumScale(1); states.setMinimumScale(30_000_000)

countries = layer("countries", "Countries")
cats = []
fld = "CONTINENT" if "CONTINENT" in [f.name() for f in countries.fields()] else None
if fld:
    colors = ["#8dd3c7", "#ffffb3", "#bebada", "#fb8072", "#80b1d3", "#fdb462", "#b3de69", "#fccde5", "#d9d9d9"]
    vals = sorted({str(f[fld]) for f in countries.getFeatures()})
    for i, v in enumerate(vals):
        s = QgsFillSymbol.createSimple({"color": colors[i % len(colors)], "outline_color": "80,80,80,255", "outline_width": "0.2"})
        cats.append(QgsRendererCategory(v, s, v))
    countries.setRenderer(QgsCategorizedSymbolRenderer(fld, cats))
else:
    countries.setRenderer(QgsSingleSymbolRenderer(QgsFillSymbol.createSimple({"color": "180,210,180,255", "outline_color": "80,80,80,255", "outline_width": "0.2"})))
lbl = QgsPalLayerSettings(); lbl.fieldName = "NAME"; lbl.placement = QgsPalLayerSettings.Horizontal if hasattr(QgsPalLayerSettings, "Horizontal") else lbl.placement
fmt = QgsTextFormat(); fmt.setFont(QFont("Open Sans")); fmt.setSize(8); fmt.setColor(QColor(40, 40, 40))
buf = fmt.buffer(); buf.setEnabled(True); buf.setSize(0.8); buf.setColor(QColor(255, 255, 255, 200)); fmt.setBuffer(buf)
lbl.setFormat(fmt); lbl.minimumScale = 60_000_000; lbl.scaleVisibility = True
countries.setLabelsEnabled(True); countries.setLabeling(QgsVectorLayerSimpleLabeling(lbl))

borders = layer("disputed_borders", "Disputed borders")
borders.setRenderer(QgsSingleSymbolRenderer(QgsLineSymbol.createSimple({"color": "200,30,30,255", "width": "0.5", "line_style": "dash"})))

for l in (borders, countries, states): p.addMapLayer(l)
root = p.layerTreeRoot()
for l in (states,): root.findLayer(l.id()).setItemVisibilityChecked(True)
assert p.write(str(OUT)), "write failed"

# QgsProject.write() does not store a map canvas (that is QgisApp's job): add the <mapcanvas> element QGIS
# desktop expects, otherwise the canvas has no extent and renders nothing until the user zooms.
from qgis.PyQt.QtXml import QDomDocument
doc = QDomDocument(); doc.setContent(OUT.read_text())
root = doc.documentElement()
canvas = doc.createElement("mapcanvas"); canvas.setAttribute("name", "theMapCanvas"); canvas.setAttribute("annotationsVisible", "1")
ms = QgsMapSettings(); ms.setDestinationCrs(p.crs()); ms.setExtent(QgsRectangle(-180, -90, 180, 90)); ms.setOutputSize(QSize(1280, 640))
ms.writeXml(canvas, doc)
root.appendChild(canvas)
# the project is generated with the system PyQGIS; mark it with the version of the QGIS we ship so that the
# "project file is older" notice does not appear (the format is compatible)
root.setAttribute("version", "4.2.3-Belém do Pará")
OUT.write_text(doc.toString(2))
txt = OUT.read_text()
txt = txt.replace(str(GPKG), WASM_GPKG).replace(os.path.relpath(GPKG, OUT.parent), WASM_GPKG)
# the shipped file names no local user (QgsProject stamps the OS account into saveUser / <author>)
txt = re.sub(r'saveUser(Full)?="[^"]*"', r'saveUser\1=""', txt)
txt = re.sub(r"<author>[^<]*</author>", "<author></author>", txt)
OUT.write_text(txt)
print("wrote", OUT, "fields:", [f.name() for f in countries.fields()][:12], "categories:", len(cats))
app.exitQgis()
