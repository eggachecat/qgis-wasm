"""qgis.core — projects, layers, features, expressions, settings, logging (PyQGIS names on top of the bridge)."""
import json
import math

from . import _bridge
from .PyQt.QtCore import QObject, pyqtSignal
from .PyQt.QtGui import QColor, QFont


# --- enums -------------------------------------------------------------------------------------------------------
class Qgis:
    class MessageLevel:
        Info, Warning, Critical, Success, NoLevel = 0, 1, 2, 3, 4

    Info, Warning, Critical, Success, NoLevel = 0, 1, 2, 3, 4

    class GeometryType:
        Point, Line, Polygon, Unknown, Null = 0, 1, 2, 3, 4

    class LayerType:
        Vector, Raster, Plugin, Mesh, VectorTile, Annotation, PointCloud, Group, TiledScene = range(9)

    class SymbolType:
        Marker, Line, Fill, Hybrid = range(4)

    class RenderUnit:
        Millimeters, MapUnits, Pixels, Percentage, Points, Inches, Unknown, MetersInMapUnits = range(8)

    class LabelPlacement:
        AroundPoint, OverPoint, Line, Curved, Horizontal, Free, OrderedPositionsAroundPoint, PerimeterCurved, OutsidePolygons = range(9)

    class LabelOverlapHandling:
        PreventOverlap, AllowOverlapIfRequired, AllowOverlapAtNoCost = range(3)

    class LabelMultiLineAlignment:
        Left, Center, Right, FollowPlacement, Justify = range(5)

    class MarkerShape:
        Square, Diamond, Pentagon, Hexagon, Triangle, EquilateralTriangle, Star, Arrow, Circle, Cross, CrossFill, Cross2, Line, ArrowHead, ArrowHeadFilled, SemiCircle, ThirdCircle, QuarterCircle, QuarterSquare, HalfSquare, DiagonalHalfSquare, RightHalfTriangle, LeftHalfTriangle = range(23)

    @staticmethod
    def version():
        return _bridge.call("qgis_version").get("version", "")

    QGIS_VERSION = "4.2"


_LEVEL_NAMES = {0: "info", 1: "warning", 2: "critical", 3: "success", 4: "info"}


def _level_name(level):
    if isinstance(level, str):
        return level
    return _LEVEL_NAMES.get(int(level), "info")


# --- geometry primitives ------------------------------------------------------------------------------------------
class QgsPointXY:
    def __init__(self, x=0.0, y=0.0):
        if isinstance(x, QgsPointXY):
            x, y = x.x(), x.y()
        elif isinstance(x, (list, tuple)):
            x, y = x[0], x[1]
        self._x, self._y = float(x), float(y)

    def x(self):
        return self._x

    def y(self):
        return self._y

    def setX(self, x):
        self._x = float(x)

    def setY(self, y):
        self._y = float(y)

    def distance(self, other):
        return math.hypot(self._x - other.x(), self._y - other.y())

    def toString(self, precision=6):
        return f"{self._x:.{precision}f},{self._y:.{precision}f}"

    def asWkt(self):
        return f"POINT({self._x} {self._y})"

    def __eq__(self, other):
        return isinstance(other, QgsPointXY) and self._x == other.x() and self._y == other.y()

    def __repr__(self):
        return f"<QgsPointXY: {self.asWkt()}>"


class QgsRectangle:
    def __init__(self, xmin=0.0, ymin=0.0, xmax=0.0, ymax=0.0):
        if isinstance(xmin, QgsPointXY) and isinstance(ymin, QgsPointXY):
            xmin, ymin, xmax, ymax = xmin.x(), xmin.y(), ymin.x(), ymin.y()
        elif isinstance(xmin, dict):
            d = xmin
            xmin, ymin, xmax, ymax = d.get("xmin", 0), d.get("ymin", 0), d.get("xmax", 0), d.get("ymax", 0)
        self._xmin, self._ymin, self._xmax, self._ymax = float(min(xmin, xmax)), float(min(ymin, ymax)), float(max(xmin, xmax)), float(max(ymin, ymax))

    def xMinimum(self):
        return self._xmin

    def yMinimum(self):
        return self._ymin

    def xMaximum(self):
        return self._xmax

    def yMaximum(self):
        return self._ymax

    def width(self):
        return self._xmax - self._xmin

    def height(self):
        return self._ymax - self._ymin

    def center(self):
        return QgsPointXY((self._xmin + self._xmax) / 2, (self._ymin + self._ymax) / 2)

    def isEmpty(self):
        return self.width() <= 0 or self.height() <= 0

    def isNull(self):
        return self._xmin == 0 and self._ymin == 0 and self._xmax == 0 and self._ymax == 0

    def scale(self, factor, center=None):
        c = center or self.center()
        w, h = self.width() * factor / 2, self.height() * factor / 2
        self._xmin, self._xmax, self._ymin, self._ymax = c.x() - w, c.x() + w, c.y() - h, c.y() + h

    def grow(self, delta):
        self._xmin -= delta
        self._ymin -= delta
        self._xmax += delta
        self._ymax += delta

    def combineExtentWith(self, other):
        if isinstance(other, QgsRectangle):
            self._xmin, self._ymin = min(self._xmin, other.xMinimum()), min(self._ymin, other.yMinimum())
            self._xmax, self._ymax = max(self._xmax, other.xMaximum()), max(self._ymax, other.yMaximum())

    def contains(self, pt):
        return self._xmin <= pt.x() <= self._xmax and self._ymin <= pt.y() <= self._ymax

    def toList(self):
        return [self._xmin, self._ymin, self._xmax, self._ymax]

    def toString(self, precision=6):
        return f"{self._xmin:.{precision}f},{self._ymin:.{precision}f} : {self._xmax:.{precision}f},{self._ymax:.{precision}f}"

    def asWktPolygon(self):
        return f"POLYGON(({self._xmin} {self._ymin}, {self._xmax} {self._ymin}, {self._xmax} {self._ymax}, {self._xmin} {self._ymax}, {self._xmin} {self._ymin}))"

    def __repr__(self):
        return f"<QgsRectangle: {self.toString()}>"


class QgsGeometry:
    """Geometry as GeoJSON (what the bridge returns); WKT and bounding boxes are derived from it."""

    def __init__(self, geojson=None):
        self._g = geojson

    @staticmethod
    def fromPointXY(pt):
        return QgsGeometry({"type": "Point", "coordinates": [pt.x(), pt.y()]})

    @staticmethod
    def fromRect(rect):
        return QgsGeometry({"type": "Polygon", "coordinates": [[[rect.xMinimum(), rect.yMinimum()], [rect.xMaximum(), rect.yMinimum()], [rect.xMaximum(), rect.yMaximum()], [rect.xMinimum(), rect.yMaximum()], [rect.xMinimum(), rect.yMinimum()]]]})

    @staticmethod
    def fromPolylineXY(points):
        return QgsGeometry({"type": "LineString", "coordinates": [[p.x(), p.y()] for p in points]})

    @staticmethod
    def fromPolygonXY(rings):
        return QgsGeometry({"type": "Polygon", "coordinates": [[[p.x(), p.y()] for p in ring] for ring in rings]})

    def isNull(self):
        return not self._g

    def isEmpty(self):
        return not self._g or not self._g.get("coordinates")

    def asJson(self, precision=17):
        return json.dumps(self._g) if self._g else ""

    def type(self):
        t = (self._g or {}).get("type", "")
        if t.endswith("Point"):
            return Qgis.GeometryType.Point
        if t.endswith("LineString"):
            return Qgis.GeometryType.Line
        if t.endswith("Polygon"):
            return Qgis.GeometryType.Polygon
        return Qgis.GeometryType.Unknown

    def _coords(self):
        def walk(c):
            if c and isinstance(c[0], (int, float)):
                yield c
            else:
                for x in c or []:
                    yield from walk(x)

        return list(walk((self._g or {}).get("coordinates", [])))

    def boundingBox(self):
        pts = self._coords()
        if not pts:
            return QgsRectangle()
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        return QgsRectangle(min(xs), min(ys), max(xs), max(ys))

    def centroid(self):
        pts = self._coords()
        if not pts:
            return QgsGeometry()
        return QgsGeometry.fromPointXY(QgsPointXY(sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)))

    def asPoint(self):
        c = (self._g or {}).get("coordinates")
        return QgsPointXY(c[0], c[1]) if c and self._g.get("type") == "Point" else QgsPointXY()

    def asWkt(self, precision=17):
        g = self._g or {}
        t = g.get("type")
        c = g.get("coordinates")

        def pt(p):
            return " ".join(repr(float(v)) for v in p)

        def ring(r):
            return "(" + ", ".join(pt(p) for p in r) + ")"

        if t == "Point":
            return f"POINT ({pt(c)})"
        if t == "MultiPoint":
            return "MULTIPOINT (" + ", ".join(f"({pt(p)})" for p in c) + ")"
        if t == "LineString":
            return "LINESTRING " + ring(c)
        if t == "MultiLineString":
            return "MULTILINESTRING (" + ", ".join(ring(l) for l in c) + ")"
        if t == "Polygon":
            return "POLYGON (" + ", ".join(ring(r) for r in c) + ")"
        if t == "MultiPolygon":
            return "MULTIPOLYGON (" + ", ".join("(" + ", ".join(ring(r) for r in poly) + ")" for poly in c) + ")"
        return ""

    def __repr__(self):
        return f"<QgsGeometry: {self.asWkt()[:60]}>"


# --- CRS ----------------------------------------------------------------------------------------------------------
class QgsCoordinateReferenceSystem:
    def __init__(self, definition=None):
        self._authid = str(definition or "")
        if self._authid.isdigit():
            self._authid = "EPSG:" + self._authid

    @staticmethod
    def fromEpsgId(code):
        return QgsCoordinateReferenceSystem(f"EPSG:{code}")

    def authid(self):
        return self._authid

    def isValid(self):
        return bool(self._authid)

    def description(self):
        return self._authid

    def isGeographic(self):
        return self._authid.upper() in ("EPSG:4326", "EPSG:4269", "EPSG:4258", "OGC:CRS84")

    def __eq__(self, other):
        return isinstance(other, QgsCoordinateReferenceSystem) and self._authid.upper() == other.authid().upper()

    def __ne__(self, other):
        return not self.__eq__(other)

    def __repr__(self):
        return f"<QgsCoordinateReferenceSystem: {self._authid}>"


class QgsCoordinateTransform:
    """Transforms through QGIS (expression engine): accurate, one round trip per call."""

    def __init__(self, source, destination, context=None):
        self._src, self._dst = source, destination

    def transform(self, point, y=None):
        if y is not None:
            point = QgsPointXY(point, y)
        if self._src == self._dst:
            return QgsPointXY(point)
        res = _bridge.call("expression_evaluate", expression=f"geom_to_wkt(transform(make_point({point.x()}, {point.y()}), '{self._src.authid()}', '{self._dst.authid()}'))")
        nums = [float(v) for v in str(res).replace("POINT", "").replace("(", "").replace(")", "").split()]
        return QgsPointXY(nums[0], nums[1])

    def transformBoundingBox(self, rect):
        if self._src == self._dst:
            return QgsRectangle(rect.xMinimum(), rect.yMinimum(), rect.xMaximum(), rect.yMaximum())
        res = _bridge.call("expression_evaluate", expression=f"geom_to_wkt(bounds(transform(geom_from_wkt('{rect.asWktPolygon()}'), '{self._src.authid()}', '{self._dst.authid()}')))")
        nums = [float(v) for v in str(res).replace("POLYGON", "").replace("(", " ").replace(")", " ").replace(",", " ").split()]
        xs, ys = nums[0::2], nums[1::2]
        return QgsRectangle(min(xs), min(ys), max(xs), max(ys))


# --- fields & features -----------------------------------------------------------------------------------------------
class QgsField:
    def __init__(self, name="", type_=None, typeName="", length=0, alias=""):
        self._name, self._typeName, self._length, self._alias = name, typeName or (type_ if isinstance(type_, str) else ""), length, alias

    def name(self):
        return self._name

    def typeName(self):
        return self._typeName

    def length(self):
        return self._length

    def alias(self):
        return self._alias

    def displayName(self):
        return self._alias or self._name

    def __repr__(self):
        return f"<QgsField: {self._name} ({self._typeName})>"


class QgsFields:
    def __init__(self, fields=None):
        self._fields = list(fields or [])

    def append(self, field):
        self._fields.append(field)
        return True

    def names(self):
        return [f.name() for f in self._fields]

    def count(self):
        return len(self._fields)

    def size(self):
        return len(self._fields)

    def indexOf(self, name):
        return self.lookupField(name)

    def lookupField(self, name):
        for i, f in enumerate(self._fields):
            if f.name() == name:
                return i
        for i, f in enumerate(self._fields):
            if f.name().lower() == str(name).lower():
                return i
        return -1

    def field(self, i):
        return self._fields[self.lookupField(i) if isinstance(i, str) else i]

    def at(self, i):
        return self._fields[i]

    def __len__(self):
        return len(self._fields)

    def __iter__(self):
        return iter(self._fields)

    def __getitem__(self, i):
        return self.field(i)

    def toList(self):
        return list(self._fields)


class QgsFeature:
    def __init__(self, fields=None, fid=None):
        self._fields = fields if isinstance(fields, QgsFields) else QgsFields()
        self._fid = fid
        self._attrs = [None] * len(self._fields)
        self._geom = QgsGeometry()

    @classmethod
    def _from_geojson(cls, f, fields):
        feat = cls(fields, f.get("id"))
        props = f.get("properties") or {}
        feat._attrs = [props.get(name) for name in fields.names()] if len(fields) else list(props.values())
        feat._props = props
        feat._geom = QgsGeometry(f.get("geometry"))
        return feat

    def id(self):
        return self._fid

    def setId(self, fid):
        self._fid = fid

    def isValid(self):
        return True

    def fields(self):
        return self._fields

    def attributes(self):
        return list(self._attrs)

    def attribute(self, key):
        return self[key]

    def attributeMap(self):
        return dict(zip(self._fields.names(), self._attrs)) if len(self._fields) else dict(getattr(self, "_props", {}))

    def setAttributes(self, attrs):
        self._attrs = list(attrs)

    def setAttribute(self, key, value):
        idx = self._fields.lookupField(key) if isinstance(key, str) else key
        if idx < 0:
            raise KeyError(key)
        self._attrs[idx] = value
        return True

    def geometry(self):
        return self._geom

    def setGeometry(self, geom):
        self._geom = geom

    def hasGeometry(self):
        return not self._geom.isNull()

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._attrs[key]
        idx = self._fields.lookupField(key)
        if idx < 0:
            props = getattr(self, "_props", {})
            if key in props:
                return props[key]
            raise KeyError(key)
        return self._attrs[idx]

    def __setitem__(self, key, value):
        self.setAttribute(key, value)

    def __repr__(self):
        return f"<QgsFeature: {self._fid}>"


class QgsFeatureRequest:
    def __init__(self, filter_=None):
        self._expression = filter_ if isinstance(filter_, str) else None
        self._limit = -1
        self._rect = filter_ if isinstance(filter_, QgsRectangle) else None
        self._fids = filter_ if isinstance(filter_, (list, set)) else None
        self._no_geometry = False
        self._subset = None

    def setFilterExpression(self, expr):
        self._expression = expr
        return self

    def setFilterRect(self, rect):
        self._rect = rect
        return self

    def setFilterFid(self, fid):
        self._fids = [fid]
        return self

    def setFilterFids(self, fids):
        self._fids = list(fids)
        return self

    def setLimit(self, limit):
        self._limit = int(limit)
        return self

    def setSubsetOfAttributes(self, attrs, fields=None):
        self._subset = [fields.at(a).name() if fields is not None and isinstance(a, int) else a for a in attrs]
        return self

    def setFlags(self, flags):
        self._no_geometry = bool(flags & QgsFeatureRequest.NoGeometry)
        return self

    def setNoAttributes(self):
        self._subset = []
        return self

    NoGeometry = 1
    NoFlags = 0
    ExactIntersect = 4

    def _expression_text(self):
        parts = []
        if self._expression:
            parts.append(f"({self._expression})")
        if self._rect is not None:
            parts.append(f"intersects_bbox($geometry, geom_from_wkt('{self._rect.asWktPolygon()}'))")
        if self._fids is not None:
            parts.append("$id IN (" + ",".join(str(int(f)) for f in self._fids) + ")") if self._fids else parts.append("FALSE")
        return " AND ".join(parts)


# --- layers ---------------------------------------------------------------------------------------------------------
class QgsMapLayer(QObject):
    nameChanged = pyqtSignal()
    repaintRequested = pyqtSignal()
    styleChanged = pyqtSignal()
    selectionChanged = pyqtSignal(list, list, bool)

    VectorLayer, RasterLayer, PluginLayer, MeshLayer, VectorTileLayer, AnnotationLayer, PointCloudLayer, GroupLayer = range(8)

    def __init__(self, data=None):
        super().__init__()
        self._d = dict(data or {})
        self._uri = self._d.get("source")
        self._name = self._d.get("name")
        self._provider = self._d.get("provider")

    # construction from a bridge record
    @classmethod
    def _wrap(cls, data):
        t = data.get("type")
        if t == "vector":
            return QgsVectorLayer(data)
        if t == "raster":
            return QgsRasterLayer(data)
        return QgsMapLayer(data)

    def _refresh(self):
        if self.id():
            for rec in _bridge.call("layers_list"):
                if rec.get("id") == self.id():
                    self._d = rec
                    break
        return self._d

    def id(self):
        return self._d.get("id")

    def name(self):
        return self._d.get("name") or self._name or ""

    def setName(self, name):
        self._name = name
        self._d["name"] = name
        if self.id():
            _bridge.call("layer_set_properties", layer=self.id(), name=str(name))
        self.nameChanged.emit()

    def isValid(self):
        return bool(self._d.get("valid", bool(self.id())))

    def type(self):
        return {"vector": QgsMapLayer.VectorLayer, "raster": QgsMapLayer.RasterLayer}.get(self._d.get("type"), QgsMapLayer.PluginLayer)

    def source(self):
        return self._d.get("source") or self._uri or ""

    def publicSource(self):
        return self.source()

    def providerType(self):
        return self._d.get("provider") or self._provider or ""

    def crs(self):
        return QgsCoordinateReferenceSystem(self._d.get("crs", ""))

    def extent(self):
        return QgsRectangle(self._d.get("extent") or {})

    def isVisible(self):
        return bool(self._d.get("visible", True))

    def setOpacity(self, opacity):
        _bridge.call("layer_style_set", layer=self.id(), opacity=float(opacity))

    def opacity(self):
        return float(self._style().get("opacity", 1.0))

    def _style(self):
        return _bridge.call("layer_style_get", layer=self.id()) if self.id() else {}

    def setMinimumScale(self, scale):
        _bridge.call("layer_style_set", layer=self.id(), min_scale=float(scale))

    def setMaximumScale(self, scale):
        _bridge.call("layer_style_set", layer=self.id(), max_scale=float(scale))

    def minimumScale(self):
        return float(self._style().get("min_scale", 0.0))

    def maximumScale(self):
        return float(self._style().get("max_scale", 0.0))

    def hasScaleBasedVisibility(self):
        return "min_scale" in self._style()

    def setScaleBasedVisibility(self, enabled):
        if not enabled:
            _bridge.call("layer_style_set", layer=self.id(), min_scale=0, max_scale=0)

    def loadNamedStyle(self, uri, *args, **kwargs):
        """Apply a .qml file of the virtual filesystem; returns (message, ok) like PyQGIS."""
        try:
            _bridge.call("layer_style_qml", layer=self.id(), path=str(uri))
            return ("", True)
        except Exception as e:  # noqa: BLE001
            return (str(e), False)

    def saveNamedStyle(self, uri, *args, **kwargs):
        try:
            _bridge.call("layer_style_qml", layer=self.id(), path=str(uri), save=True)
            return ("", True)
        except Exception as e:  # noqa: BLE001
            return (str(e), False)

    def exportNamedStyle(self, *args, **kwargs):
        """The current style as QML text (PyQGIS fills a QDomDocument; here the text is returned)."""
        return _bridge.call("layer_style_qml", layer=self.id()).get("qml", "")

    def importNamedStyle(self, qml, *args, **kwargs):
        _bridge.call("layer_style_qml", layer=self.id(), qml=str(qml))
        return (True, "")

    def setBlendMode(self, mode):
        _bridge.log("QgsMapLayer.setBlendMode is not supported in the browser compatibility layer", "Python", "warning")

    def triggerRepaint(self, deferred=False):
        _bridge.call("canvas_refresh")
        self.repaintRequested.emit()

    def __eq__(self, other):
        return isinstance(other, QgsMapLayer) and self.id() is not None and self.id() == other.id()

    def __hash__(self):
        return hash(self.id())

    def __repr__(self):
        return f"<{type(self).__name__}: {self.name()!r} {self.id()}>"


class QgsVectorLayer(QgsMapLayer):
    featureAdded = pyqtSignal(int)
    featureDeleted = pyqtSignal(int)

    def __init__(self, path=None, baseName="", providerLib="ogr", options=None):
        if isinstance(path, dict):
            super().__init__(path)
        else:
            super().__init__({"type": "vector"})
            self._uri, self._name, self._provider = path, baseName, providerLib

    def geometryType(self):
        g = str(self._d.get("geometry", "")).lower()
        if "point" in g:
            return Qgis.GeometryType.Point
        if "line" in g:
            return Qgis.GeometryType.Line
        if "polygon" in g:
            return Qgis.GeometryType.Polygon
        return Qgis.GeometryType.Unknown

    def featureCount(self):
        return int(self._d.get("featureCount", -1)) if self.id() else 0

    def fields(self):
        if not self.id():
            return QgsFields()
        return QgsFields([QgsField(f["name"], typeName=f.get("type", ""), length=f.get("length", 0), alias=f.get("alias", "")) for f in _bridge.call("layer_fields", layer=self.id())])

    def getFeatures(self, request=None):
        if not self.id():
            return iter(())
        if isinstance(request, str):
            request = QgsFeatureRequest(request)
        req = request or QgsFeatureRequest()
        params = {"layer": self.id(), "geometry": not req._no_geometry, "limit": req._limit if req._limit > 0 else 100000}
        expr = req._expression_text()
        if expr:
            params["expression"] = expr
        if req._subset is not None:
            params["fields"] = list(req._subset)
        fc = _bridge.call("layer_features", params)
        fields = self.fields()
        return iter([QgsFeature._from_geojson(f, fields) for f in (fc or {}).get("features", [])])

    def getFeature(self, fid):
        feats = list(self.getFeatures(QgsFeatureRequest().setFilterFid(fid)))
        return feats[0] if feats else QgsFeature()

    def selectByExpression(self, expression, behavior=0, context=None):
        _bridge.call("layer_select", layer=self.id(), expression=expression, behavior={0: "set", 1: "add", 2: "intersect", 3: "remove"}.get(int(behavior), "set"))

    def selectByIds(self, ids, behavior=0):
        self.selectByExpression("$id IN (" + ",".join(str(int(i)) for i in ids) + ")" if ids else "FALSE", behavior)

    def selectAll(self):
        self.selectByExpression("TRUE")

    def removeSelection(self):
        _bridge.call("layer_select", layer=self.id(), expression="")

    def selectedFeatureCount(self):
        return int(self._refresh().get("selectedCount", 0))

    def selectedFeatures(self):
        fc = _bridge.call("layer_features", layer=self.id(), selected=True, geometry=True, limit=100000)
        fields = self.fields()
        return [QgsFeature._from_geojson(f, fields) for f in (fc or {}).get("features", [])]

    def selectedFeatureIds(self):
        return [f.id() for f in self.selectedFeatures()]

    def boundingBoxOfSelected(self):
        rect = None
        for f in self.selectedFeatures():
            b = f.geometry().boundingBox()
            if rect is None:
                rect = b
            else:
                rect.combineExtentWith(b)
        return rect or QgsRectangle()

    # --- symbology and labels: PyQGIS objects on top of layer_style_get / layer_style_set (JSON documents)
    def renderer(self):
        return QgsFeatureRenderer._from_json(self._style().get("renderer") or {}, self)

    def setRenderer(self, renderer):
        if renderer is None:
            return
        out = _bridge.call("layer_style_set", layer=self.id(), renderer=renderer._json())
        renderer._bind(self, (out or {}).get("renderer") or {})
        self.styleChanged.emit()

    def labeling(self):
        labels = self._style().get("labels") or {}
        if not (labels.get("field") or labels.get("expression")):
            return None
        return QgsVectorLayerSimpleLabeling(QgsPalLayerSettings._from_json(labels))

    def setLabeling(self, labeling):
        if labeling is None:
            _bridge.call("layer_style_set", layer=self.id(), labels={"enabled": False})
            return
        _bridge.call("layer_style_set", layer=self.id(), labels=labeling._json())
        self.styleChanged.emit()

    def labelsEnabled(self):
        return bool((self._style().get("labels") or {}).get("enabled"))

    def setLabelsEnabled(self, enabled):
        labels = self._style().get("labels") or {}
        if not enabled:
            if labels.get("enabled"):
                _bridge.call("layer_style_set", layer=self.id(), labels={"enabled": False})
        elif labels.get("field") or labels.get("expression"):
            _bridge.call("layer_style_set", layer=self.id(), labels={"enabled": True})
        self.styleChanged.emit()

    def wkbType(self):
        return self._d.get("geometry", "")

    def dataProvider(self):
        return _DataProvider(self)

    def setSubsetString(self, subset):
        _bridge.log("QgsVectorLayer.setSubsetString is not supported in the browser; use selectByExpression or Processing", "Python", "warning")
        return False

    def startEditing(self):
        _bridge.log("editing through Python is not supported in the browser (use the QGIS editing toolbar or Processing)", "Python", "warning")
        return False

    def commitChanges(self):
        return False


class _DataProvider:
    def __init__(self, layer):
        self._layer = layer

    def name(self):
        return self._layer.providerType()

    def dataSourceUri(self):
        return self._layer.source()

    def featureCount(self):
        return self._layer.featureCount()

    def fields(self):
        return self._layer.fields()

    def extent(self):
        return self._layer.extent()

    def crs(self):
        return self._layer.crs()


class QgsRasterLayer(QgsMapLayer):
    def __init__(self, uri=None, baseName="", providerType="gdal", options=None):
        if isinstance(uri, dict):
            super().__init__(uri)
        else:
            super().__init__({"type": "raster"})
            self._uri, self._name, self._provider = uri, baseName, providerType

    def bandCount(self):
        return int(self._d.get("bands", 0))

    def width(self):
        return int(self._d.get("width", 0))

    def height(self):
        return int(self._d.get("height", 0))


# --- project ------------------------------------------------------------------------------------------------------
class QgsProject(QObject):
    layersAdded = pyqtSignal(list)
    layerWasAdded = pyqtSignal(object)
    layersRemoved = pyqtSignal(list)
    layerRemoved = pyqtSignal(str)
    readProject = pyqtSignal(object)
    cleared = pyqtSignal()
    crsChanged = pyqtSignal()

    _instance = None

    @classmethod
    def instance(cls):
        if cls._instance is None:
            cls._instance = cls()
            cls._instance._wire()
        return cls._instance

    def _wire(self):
        _bridge.subscribe("layers.added", lambda p: (self.layersAdded.emit([QgsMapLayer._wrap(l) for l in p.get("layers", [])]), [self.layerWasAdded.emit(QgsMapLayer._wrap(l)) for l in p.get("layers", [])]))
        _bridge.subscribe("layers.removed", lambda p: (self.layersRemoved.emit(list(p.get("ids", []))), [self.layerRemoved.emit(i) for i in p.get("ids", [])]))
        _bridge.subscribe("project.read", lambda p: self.readProject.emit(None))
        _bridge.subscribe("project.cleared", lambda p: self.cleared.emit())

    def _info(self):
        return _bridge.call("project_info")

    def mapLayers(self, validOnly=False):
        return {rec["id"]: QgsMapLayer._wrap(rec) for rec in _bridge.call("layers_list") if not validOnly or rec.get("valid", True)}

    def mapLayer(self, layerId):
        return self.mapLayers().get(layerId)

    def mapLayersByName(self, name):
        return [l for l in self.mapLayers().values() if l.name() == name]

    def count(self):
        return len(_bridge.call("layers_list"))

    def addMapLayer(self, layer, addToLegend=True):
        if layer.id():
            return layer
        if not layer.source():
            raise ValueError("layer has no data source")
        params = {"uri": layer.source(), "name": layer.name() or None, "provider": layer.providerType() or None}
        if isinstance(layer, QgsRasterLayer) and params["provider"] == "gdal":
            params["provider"] = None  # let QGIS describe the file
        if isinstance(layer, QgsVectorLayer) and params["provider"] == "ogr":
            params["provider"] = None
        added = _bridge.call("layers_add", {k: v for k, v in params.items() if v is not None})
        if isinstance(added, dict):  # project file
            return None
        if not added:
            return None
        layer._d = added[0]
        return layer

    def addMapLayers(self, layers, addToLegend=True):
        return [l for l in (self.addMapLayer(layer, addToLegend) for layer in layers) if l is not None]

    def removeMapLayer(self, layer):
        layer_id = layer.id() if isinstance(layer, QgsMapLayer) else layer
        if layer_id:
            _bridge.call("layers_remove", layer=layer_id)

    def removeMapLayers(self, layers):
        for l in layers:
            self.removeMapLayer(l)

    def removeAllMapLayers(self):
        for lid in list(self.mapLayers()):
            self.removeMapLayer(lid)

    def read(self, filename=None, flags=None):
        if filename:
            _bridge.call("project_open", path=filename)
        return True

    def write(self, filename=None):
        _bridge.call("project_save", path=filename)
        return True

    def clear(self):
        _bridge.call("project_new")

    def fileName(self):
        return self._info().get("file", "")

    def setFileName(self, name):
        self._pending_file = name

    def absolutePath(self):
        fn = self.fileName()
        return fn.rsplit("/", 1)[0] if "/" in fn else ""

    def absoluteFilePath(self):
        return self.fileName()

    def baseName(self):
        fn = self.fileName().rsplit("/", 1)[-1]
        return fn.rsplit(".", 1)[0]

    def title(self):
        return self._info().get("title", "")

    def setTitle(self, title):
        _bridge.log("QgsProject.setTitle is not supported yet", "Python", "warning")

    def crs(self):
        return QgsCoordinateReferenceSystem(self._info().get("crs", ""))

    def setCrs(self, crs, adjustEllipsoid=False):
        _bridge.call("project_set_crs", crs=crs.authid() if isinstance(crs, QgsCoordinateReferenceSystem) else str(crs))
        self.crsChanged.emit()

    def isDirty(self):
        return bool(self._info().get("dirty"))

    def homePath(self):
        return self.absolutePath() or "/home/web_user"

    def readEntry(self, scope, key, default=None):
        return (default, False)

    def writeEntry(self, scope, key, value):
        return False

    def layerTreeRoot(self):
        return _LayerTreeRoot(self)

    def transformContext(self):
        return None


class _LayerTreeLayer:
    def __init__(self, layer):
        self._layer = layer

    def layer(self):
        return self._layer

    def layerId(self):
        return self._layer.id()

    def name(self):
        return self._layer.name()

    def isVisible(self):
        return self._layer.isVisible()

    def setItemVisibilityChecked(self, checked):
        _bridge.call("layers_set_visible", layer=self._layer.id(), visible=bool(checked))

    def itemVisibilityChecked(self):
        return self._layer.isVisible()


class _LayerTreeRoot:
    def __init__(self, project):
        self._project = project

    def findLayers(self):
        return [_LayerTreeLayer(l) for l in self._project.mapLayers().values()]

    def findLayer(self, layer):
        lid = layer.id() if isinstance(layer, QgsMapLayer) else layer
        l = self._project.mapLayer(lid)
        return _LayerTreeLayer(l) if l else None

    def children(self):
        return self.findLayers()

    def layerOrder(self):
        return list(self._project.mapLayers().values())


# --- expressions --------------------------------------------------------------------------------------------------
class QgsExpressionContextScope:
    def __init__(self, name=""):
        self.name = name


class QgsExpressionContext:
    def __init__(self, scopes=None):
        self._layer = None
        self._feature = None
        if scopes:
            for s in scopes:
                if isinstance(s, QgsExpressionContextScope) and getattr(s, "layer", None) is not None:
                    self._layer = s.layer

    def appendScope(self, scope):
        if getattr(scope, "layer", None) is not None:
            self._layer = scope.layer

    def appendScopes(self, scopes):
        for s in scopes:
            self.appendScope(s)

    def setFeature(self, feature):
        self._feature = feature


class QgsExpressionContextUtils:
    @staticmethod
    def globalScope():
        return QgsExpressionContextScope("global")

    @staticmethod
    def projectScope(project=None):
        return QgsExpressionContextScope("project")

    @staticmethod
    def layerScope(layer):
        s = QgsExpressionContextScope("layer")
        s.layer = layer
        return s

    @staticmethod
    def globalProjectLayerScopes(layer):
        return [QgsExpressionContextUtils.globalScope(), QgsExpressionContextUtils.projectScope(), QgsExpressionContextUtils.layerScope(layer)]


class QgsExpression:
    def __init__(self, expression=""):
        self._expr = str(expression)
        self._error = ""

    def expression(self):
        return self._expr

    def isValid(self):
        return not self.hasParserError()

    def hasParserError(self):
        try:
            self.evaluate()
            return False
        except Exception as e:  # noqa: BLE001
            self._error = str(e)
            return "parse error" in str(e)

    def parserErrorString(self):
        return self._error

    def hasEvalError(self):
        return bool(self._error)

    def evalErrorString(self):
        return self._error

    def prepare(self, context=None):
        return True

    def evaluate(self, context=None):
        params = {"expression": self._expr}
        if context is not None and getattr(context, "_layer", None) is not None:
            params["layer"] = context._layer.id()
        if context is not None and getattr(context, "_feature", None) is not None and context._feature.id() is not None:
            # evaluate per feature through a filter: attribute(get_feature_by_id(...)) is heavier; use attribute lookups
            feat = context._feature
            expr = self._expr
            for name in feat.fields().names():
                val = feat[name]
                literal = "NULL" if val is None else (repr(val) if isinstance(val, (int, float)) else "'" + str(val).replace("'", "''") + "'")
                expr = expr.replace(f'"{name}"', literal)
            params["expression"] = expr
        try:
            self._error = ""
            return _bridge.call("expression_evaluate", params)
        except _bridge.QgsWasmBridgeError as e:
            self._error = str(e)
            raise

    @staticmethod
    def quotedValue(value):
        if value is None:
            return "NULL"
        if isinstance(value, (int, float)):
            return repr(value)
        return "'" + str(value).replace("'", "''") + "'"

    @staticmethod
    def quotedColumnRef(name):
        return '"' + str(name).replace('"', '\\"') + '"'


# --- settings, logging, application ------------------------------------------------------------------------------
class QgsSettings:
    def __init__(self, *args, **kwargs):
        self._prefix = ""

    def beginGroup(self, prefix):
        self._prefix += prefix.strip("/") + "/"

    def endGroup(self):
        self._prefix = "/".join(self._prefix.strip("/").split("/")[:-1])
        self._prefix = self._prefix + "/" if self._prefix else ""

    def _key(self, key):
        return self._prefix + key.lstrip("/")

    def value(self, key, defaultValue=None, type=None, section=None):
        v = _bridge.call("settings_get", key=self._key(key))
        if v is None:
            return defaultValue
        if type is bool or isinstance(defaultValue, bool):
            return str(v).lower() in ("true", "1", "yes") if not isinstance(v, bool) else v
        if type is int or isinstance(defaultValue, int) and not isinstance(defaultValue, bool):
            try:
                return int(v)
            except Exception:  # noqa: BLE001
                return defaultValue
        if type is float or isinstance(defaultValue, float):
            try:
                return float(v)
            except Exception:  # noqa: BLE001
                return defaultValue
        return v

    def setValue(self, key, value, section=None):
        _bridge.call("settings_set", key=self._key(key), value=value)

    def contains(self, key, section=None):
        return _bridge.call("settings_get", key=self._key(key)) is not None

    def remove(self, key, section=None):
        _bridge.call("settings_set", key=self._key(key), value=None)

    def sync(self):
        pass


QSettings = QgsSettings


class QgsMessageLog:
    messageReceived = pyqtSignal(str, str, int)

    @staticmethod
    def logMessage(message, tag="General", level=Qgis.Info, notifyUser=True):
        _bridge.log(message, tag, _level_name(level))


class QgsApplication:
    _registry = None

    @staticmethod
    def instance():
        return QgsApplication

    @staticmethod
    def processingRegistry():
        from . import _processing_registry

        return _processing_registry

    @staticmethod
    def prefixPath():
        return "/qgis"

    @staticmethod
    def pkgDataPath():
        return "/qgis/share/qgis"

    @staticmethod
    def qgisUserDatabaseFilePath():
        return "/home/web_user/.local/share/QGIS/QGIS4/profiles/default/qgis.db"

    @staticmethod
    def qgisSettingsDirPath():
        return "/home/web_user/.local/share/QGIS/QGIS4/profiles/default/"

    @staticmethod
    def platform():
        return "wasm"

    @staticmethod
    def translate(context, text, *args):
        return text

    @staticmethod
    def locale():
        return "en"


class QgsProcessingFeedback:
    def __init__(self, logFeedback=True):
        self._progress = 0.0
        self._cancelled = False

    def setProgress(self, progress):
        self._progress = float(progress)

    def progress(self):
        return self._progress

    def isCanceled(self):
        return self._cancelled

    def cancel(self):
        self._cancelled = True

    def pushInfo(self, info):
        _bridge.log(info, "Processing", "info")

    def pushWarning(self, w):
        _bridge.log(w, "Processing", "warning")

    def reportError(self, e, fatalError=False):
        _bridge.log(e, "Processing", "critical")

    def pushCommandInfo(self, info):
        _bridge.log(info, "Processing", "info")

    def pushDebugInfo(self, info):
        pass


class QgsProcessingContext:
    def __init__(self):
        pass

    def setProject(self, project):
        pass

    def project(self):
        return QgsProject.instance()


class QgsVectorLayerUtils:
    @staticmethod
    def getValues(layer, fieldOrExpression, selectedOnly=False):
        name = fieldOrExpression
        fc = _bridge.call("layer_features", layer=layer.id(), selected=bool(selectedOnly), geometry=False, limit=100000, fields=[name])
        return ([f.get("properties", {}).get(name) for f in fc.get("features", [])], True)


# --- symbology and labelling ---------------------------------------------------------------------------------------
# PyQGIS classes as plain data holders over the JSON style document of the bridge (layer_style_get / layer_style_set):
# nothing happens until layer.setRenderer() / layer.setLabeling() sends the document to QGIS, exactly like PyQGIS
# (objects are detached copies). See docs/03 for the subset.
def _color_name(c):
    if isinstance(c, QColor):
        return c.name(QColor.HexArgbCss)
    return str(c) if c is not None else None


def _unit_name(unit):
    if isinstance(unit, str):
        return unit
    return {0: "mm", 1: "map_units", 2: "pixels", 4: "points", 7: "meters"}.get(int(unit), "points")


def _unit_value(name):
    return {"mm": 0, "map_units": 1, "pixels": 2, "points": 4, "meters": 7}.get(str(name), 4)


_SHAPE_NAMES = ["square", "diamond", "pentagon", "hexagon", "triangle", "equilateral_triangle", "star", "arrow", "circle", "cross", "cross_fill", "cross2", "line", "arrowhead", "filled_arrowhead", "semi_circle", "third_circle", "quarter_circle", "quarter_square", "half_square", "diagonal_half_square", "right_half_triangle", "left_half_triangle"]
_PLACEMENT_NAMES = ["around_point", "over_point", "line", "curved", "horizontal", "free", "ordered_around_point", "perimeter_curved", "outside_polygons"]
_OVERLAP_NAMES = ["prevent", "allow_if_required", "allow"]
_ALIGN_NAMES = ["left", "center", "right", "follow", "justify"]


class QgsColorRamp:
    """A colour ramp by name (``QgsStyle.defaultStyle().colorRamp('Viridis')``) or by colours."""

    def __init__(self, name=None, colors=None, invert=False):
        self._name, self._colors, self._invert = name, list(colors or []), bool(invert)

    def invert(self):
        self._invert = not self._invert
        return self

    def clone(self):
        return QgsColorRamp(self._name, self._colors, self._invert)

    def _json(self):
        if self._colors:
            return {"colors": [_color_name(c) for c in self._colors], "invert": self._invert} if self._invert else [_color_name(c) for c in self._colors]
        return {"name": self._name or "Viridis", "invert": self._invert}


class QgsGradientColorRamp(QgsColorRamp):
    def __init__(self, color1=None, color2=None, discrete=False, stops=None):
        colors = [color1 or QColor("#ffffff")] + [c for _, c in (stops or [])] + [color2 or QColor("#000000")]
        super().__init__(None, colors)

    def color1(self):
        return QColor(self._colors[0])

    def color2(self):
        return QColor(self._colors[-1])


class QgsGradientStop:
    def __init__(self, offset, color):
        self.offset, self.color = offset, color

    def __iter__(self):
        return iter((self.offset, self.color))


class QgsRandomColorRamp(QgsColorRamp):
    def __init__(self, *a, **k):
        super().__init__("random")


QgsLimitedRandomColorRamp = QgsRandomColorRamp


class QgsColorBrewerColorRamp(QgsColorRamp):
    def __init__(self, schemeName="Spectral", colors=5, inverted=False):
        super().__init__(schemeName, None, inverted)


class QgsStyle:
    _instance = None
    _RAMPS = ["Blues", "BrBG", "BuGn", "BuPu", "Cividis", "GnBu", "Greens", "Greys", "Inferno", "Magma", "Mako", "OrRd", "Oranges", "PRGn", "PiYG", "Plasma", "PuBu", "PuBuGn", "PuOr", "PuRd", "Purples", "RdBu", "RdGy", "RdPu", "RdYlBu", "RdYlGn", "Reds", "Rocket", "Spectral", "Turbo", "Viridis", "YlGn", "YlGnBu", "YlOrBr", "YlOrRd"]

    @classmethod
    def defaultStyle(cls, initialize=True):
        if cls._instance is None:
            cls._instance = QgsStyle()
        return cls._instance

    def colorRamp(self, name):
        return QgsColorRamp(name)

    def colorRampNames(self):
        return list(self._RAMPS)

    def colorRampRef(self, name):
        return self.colorRamp(name)


class QgsSymbolLayer:
    """The first (simple) layer of a symbol: the keys live in the symbol's JSON, so changes stay with it."""

    def __init__(self, symbol):
        self._s = symbol

    def _get(self, key, default=None):
        return self._s._j.get(key, default)

    def _set(self, key, value):
        self._s._j[key] = value

    def layerType(self):
        return {"marker": "SimpleMarker", "line": "SimpleLine", "fill": "SimpleFill"}.get(self._s.type_name(), "Simple")

    def color(self):
        return QColor(self._get("color", "#000000"))

    def setColor(self, color):
        self._set("color", _color_name(color))

    fillColor, setFillColor = color, setColor

    def strokeColor(self):
        return QColor(self._get("stroke_color", "#000000"))

    def setStrokeColor(self, color):
        self._set("stroke_color", _color_name(color))

    def strokeWidth(self):
        return float(self._get("stroke_width", 0.26))

    def setStrokeWidth(self, w):
        self._set("stroke_width", float(w))

    def setStrokeStyle(self, style):
        self._set("stroke_style", _pen_style_name(style))

    setPenStyle = setStrokeStyle

    def setBrushStyle(self, style):
        self._set("fill_style", "no" if style in (0, "no", "NoBrush") else "solid")

    def size(self):
        return float(self._get("size", 2.0))

    def setSize(self, size):
        self._set("size", float(size))

    def width(self):
        return float(self._get("width", 0.26))

    def setWidth(self, w):
        self._set("width", float(w))

    def shape(self):
        return _SHAPE_NAMES.index(self._get("shape", "circle")) if self._get("shape", "circle") in _SHAPE_NAMES else Qgis.MarkerShape.Circle

    def setShape(self, shape):
        self._set("shape", shape if isinstance(shape, str) else _SHAPE_NAMES[int(shape)] if 0 <= int(shape) < len(_SHAPE_NAMES) else "circle")

    def setAngle(self, angle):
        self._set("angle", float(angle))

    def properties(self):
        return dict(self._s._j)


def _pen_style_name(style):
    if isinstance(style, str):
        return style
    return {0: "no", 1: "solid", 2: "dash", 3: "dot", 4: "dash dot", 5: "dash dot dot"}.get(int(style), "solid")


class QgsSymbol:
    """A symbol = one JSON object {type, color, opacity, size | width, shape, stroke_color, stroke_width, stroke_style, fill_style}."""

    def __init__(self, data=None, type_name=None):
        self._j = dict(data or {})
        if type_name and "type" not in self._j:
            self._j["type"] = type_name

    @staticmethod
    def defaultSymbol(geomType):
        g = int(geomType) if not isinstance(geomType, str) else {"point": 0, "line": 1, "polygon": 2}.get(geomType.lower(), 0)
        if g == Qgis.GeometryType.Point:
            return QgsMarkerSymbol()
        if g == Qgis.GeometryType.Line:
            return QgsLineSymbol()
        return QgsFillSymbol()

    @classmethod
    def _from_json(cls, j):
        j = dict(j or {})
        t = j.get("type")
        klass = {"marker": QgsMarkerSymbol, "line": QgsLineSymbol, "fill": QgsFillSymbol}.get(t, QgsSymbol)
        return klass(j)

    @classmethod
    def createSimple(cls, properties):
        """PyQGIS property names (color, outline_color, outline_width, size, name = shape, width, style) → symbol."""
        p = dict(properties or {})
        j = {}
        for src, dst in (("color", "color"), ("outline_color", "stroke_color"), ("stroke_color", "stroke_color"), ("outline_width", "stroke_width"), ("stroke_width", "stroke_width"), ("size", "size"), ("width", "width"), ("name", "shape"), ("shape", "shape"), ("outline_style", "stroke_style"), ("stroke_style", "stroke_style"), ("style", "fill_style"), ("opacity", "opacity"), ("angle", "angle")):
            if src in p and dst not in j:
                j[dst] = p[src]
        for k in ("size", "width", "stroke_width", "opacity", "angle"):
            if k in j:
                try:
                    j[k] = float(j[k])
                except (TypeError, ValueError):
                    pass
        return cls(j, cls._TYPE)

    _TYPE = None

    def type_name(self):
        return self._j.get("type") or self._TYPE or "marker"

    def type(self):
        return {"marker": Qgis.SymbolType.Marker, "line": Qgis.SymbolType.Line, "fill": Qgis.SymbolType.Fill}.get(self.type_name(), Qgis.SymbolType.Hybrid)

    def color(self):
        return QColor(self._j.get("color", "#000000"))

    def setColor(self, color):
        self._j["color"] = _color_name(color)

    def opacity(self):
        return float(self._j.get("opacity", 1.0))

    def setOpacity(self, opacity):
        self._j["opacity"] = float(opacity)

    def symbolLayer(self, index=0):
        return QgsSymbolLayer(self)

    def symbolLayers(self):
        return [QgsSymbolLayer(self)]

    def symbolLayerCount(self):
        return 1

    def changeSymbolLayer(self, index, layer):
        if isinstance(layer, QgsSymbolLayer):
            self._j.update({k: v for k, v in layer._s._j.items() if k != "type"})
        return True

    def appendSymbolLayer(self, layer):
        return self.changeSymbolLayer(0, layer)

    def clone(self):
        return type(self)(dict(self._j))

    def _json(self):
        return {k: v for k, v in self._j.items() if v is not None}

    def __repr__(self):
        return f"<{type(self).__name__} {self._j}>"


class QgsMarkerSymbol(QgsSymbol):
    _TYPE = "marker"

    def __init__(self, data=None):
        super().__init__(data, "marker")

    def size(self):
        return float(self._j.get("size", 2.0))

    def setSize(self, size, *a):
        self._j["size"] = float(size)

    def setSizeUnit(self, unit):
        pass

    def setAngle(self, angle):
        self._j["angle"] = float(angle)


class QgsLineSymbol(QgsSymbol):
    _TYPE = "line"

    def __init__(self, data=None):
        super().__init__(data, "line")

    def width(self):
        return float(self._j.get("width", 0.26))

    def setWidth(self, w, *a):
        self._j["width"] = float(w)

    def setWidthUnit(self, unit):
        pass


class QgsFillSymbol(QgsSymbol):
    _TYPE = "fill"

    def __init__(self, data=None):
        super().__init__(data, "fill")


class QgsSimpleMarkerSymbolLayer(QgsSymbolLayer):
    def __init__(self, shape="circle", color=None, strokeColor=None, size=2.0, *a, **k):
        super().__init__(QgsMarkerSymbol({"shape": shape if isinstance(shape, str) else _SHAPE_NAMES[int(shape)], "size": float(size)}))
        if color is not None:
            self.setColor(color)
        if strokeColor is not None:
            self.setStrokeColor(strokeColor)


class QgsSimpleLineSymbolLayer(QgsSymbolLayer):
    def __init__(self, color=None, width=0.26, penStyle=1, *a, **k):
        super().__init__(QgsLineSymbol({"width": float(width), "stroke_style": _pen_style_name(penStyle)}))
        if color is not None:
            self.setColor(color)


class QgsSimpleFillSymbolLayer(QgsSymbolLayer):
    def __init__(self, color=None, style=1, strokeColor=None, strokeStyle=1, strokeWidth=0.26, *a, **k):
        super().__init__(QgsFillSymbol({"stroke_width": float(strokeWidth), "stroke_style": _pen_style_name(strokeStyle)}))
        if color is not None:
            self.setColor(color)
        if strokeColor is not None:
            self.setStrokeColor(strokeColor)


class QgsRendererCategory:
    def __init__(self, value=None, symbol=None, label=None, render=True, uuid=None):
        self._value, self._symbol, self._label, self._render = value, symbol, label if label is not None else ("" if value is None else str(value)), bool(render)

    def value(self):
        return self._value

    def symbol(self):
        return self._symbol

    def label(self):
        return self._label

    def renderState(self):
        return self._render

    def setValue(self, v):
        self._value = v

    def setSymbol(self, s):
        self._symbol = s

    def setLabel(self, l):
        self._label = l

    def setRenderState(self, r):
        self._render = bool(r)

    def _json(self):
        o = {"value": self._value, "label": self._label, "enabled": self._render}
        if self._symbol is not None:
            o["symbol"] = self._symbol._json()
        return o


class QgsRendererRange:
    def __init__(self, lowerValue=0.0, upperValue=0.0, symbol=None, label=None, render=True, uuid=None):
        self._lower, self._upper, self._symbol, self._label, self._render = float(lowerValue), float(upperValue), symbol, label if label is not None else f"{lowerValue} - {upperValue}", bool(render)

    def lowerValue(self):
        return self._lower

    def upperValue(self):
        return self._upper

    def symbol(self):
        return self._symbol

    def label(self):
        return self._label

    def renderState(self):
        return self._render

    def setLowerValue(self, v):
        self._lower = float(v)

    def setUpperValue(self, v):
        self._upper = float(v)

    def setSymbol(self, s):
        self._symbol = s

    def setLabel(self, l):
        self._label = l

    def _json(self):
        o = {"lower": self._lower, "upper": self._upper, "label": self._label, "enabled": self._render}
        if self._symbol is not None:
            o["symbol"] = self._symbol._json()
        return o


class QgsClassificationMethod:
    _ID = "Custom"

    def id(self):
        return self._ID

    def setLabelFormat(self, *a):
        pass

    def setLabelPrecision(self, *a):
        pass


class QgsClassificationQuantile(QgsClassificationMethod):
    _ID = "Quantile"


class QgsClassificationEqualInterval(QgsClassificationMethod):
    _ID = "EqualInterval"


class QgsClassificationJenks(QgsClassificationMethod):
    _ID = "Jenks"


class QgsClassificationStandardDeviation(QgsClassificationMethod):
    _ID = "StdDev"


class QgsClassificationPrettyBreaks(QgsClassificationMethod):
    _ID = "Pretty"


class QgsClassificationLogarithmic(QgsClassificationMethod):
    _ID = "Logarithmic"


_MODE_IDS = {"Quantile": "quantile", "EqualInterval": "equal_interval", "Jenks": "jenks", "StdDev": "stddev", "Pretty": "pretty", "Logarithmic": "log", "Custom": "custom"}


class QgsFeatureRenderer:
    """Base of the renderers; ``_json()`` is the bridge document, ``_bind()`` takes QGIS' answer back (computed classes)."""

    _TYPE = ""

    def __init__(self):
        self._layer = None

    def type(self):
        return self._TYPE

    @staticmethod
    def _from_json(j, layer=None):
        t = (j or {}).get("type")
        if t == "categorized":
            r = QgsCategorizedSymbolRenderer(j.get("field", ""))
            r._cats = [QgsRendererCategory(c.get("value"), QgsSymbol._from_json(dict(j.get("symbol") or {}, color=c.get("color"))), c.get("label"), c.get("enabled", True)) for c in j.get("categories", [])]
        elif t == "graduated":
            r = QgsGraduatedSymbolRenderer(j.get("field", ""))
            r._ranges = [QgsRendererRange(c.get("lower", 0), c.get("upper", 0), QgsSymbol._from_json(dict(j.get("symbol") or {}, color=c.get("color"))), c.get("label"), c.get("enabled", True)) for c in j.get("ranges", [])]
            r._mode = j.get("mode")
        elif t == "single" or not t:
            r = QgsSingleSymbolRenderer(QgsSymbol._from_json(j.get("symbol") or {}))
        else:
            r = QgsFeatureRenderer()
            r._TYPE = t
        if j.get("symbol") and hasattr(r, "_source"):
            r._source = QgsSymbol._from_json(j.get("symbol"))
        r._layer = layer
        return r

    def _json(self):
        return {"type": self._TYPE}

    def _bind(self, layer, result):
        self._layer = layer

    def clone(self):
        import copy

        return copy.deepcopy(self)

    def dump(self):
        return json.dumps(self._json())

    def symbols(self, *a):
        return []

    def usedAttributes(self, *a):
        return set()

    def legendClassificationAttribute(self):
        return ""


class QgsSingleSymbolRenderer(QgsFeatureRenderer):
    _TYPE = "singleSymbol"

    def __init__(self, symbol=None):
        super().__init__()
        self._symbol = symbol if symbol is not None else QgsMarkerSymbol()

    def symbol(self):
        return self._symbol

    def setSymbol(self, symbol):
        self._symbol = symbol

    def symbols(self, *a):
        return [self._symbol]

    def _json(self):
        return {"type": "single", "symbol": self._symbol._json() if self._symbol is not None else {}}


class QgsCategorizedSymbolRenderer(QgsFeatureRenderer):
    _TYPE = "categorizedSymbol"

    def __init__(self, attrName="", categories=None):
        super().__init__()
        self._attr, self._cats, self._source, self._ramp = attrName, list(categories or []), None, None

    def classAttribute(self):
        return self._attr

    def setClassAttribute(self, attr):
        self._attr = attr

    legendClassificationAttribute = classAttribute

    def categories(self):
        return list(self._cats)

    def addCategory(self, cat):
        self._cats.append(cat)

    def deleteAllCategories(self):
        self._cats = []

    def deleteCategory(self, index):
        del self._cats[index]

    def updateCategoryLabel(self, index, label):
        self._cats[index].setLabel(label)

    def updateCategoryValue(self, index, value):
        self._cats[index].setValue(value)

    def updateCategorySymbol(self, index, symbol):
        self._cats[index].setSymbol(symbol)

    def sourceSymbol(self):
        return self._source

    def setSourceSymbol(self, symbol):
        self._source = symbol

    def sourceColorRamp(self):
        return self._ramp

    def setSourceColorRamp(self, ramp):
        self._ramp = ramp

    def updateColorRamp(self, ramp):
        self._ramp = ramp
        for c in self._cats:  # colours are assigned by QGIS from the ramp
            if c.symbol() is not None:
                c.symbol()._j.pop("color", None)

    def updateSymbols(self, symbol):
        self._source = symbol
        for c in self._cats:
            colour = c.symbol()._j.get("color") if c.symbol() is not None else None
            c.setSymbol(symbol.clone())
            if colour:
                c.symbol().setColor(colour)

    def symbols(self, *a):
        return [c.symbol() for c in self._cats if c.symbol() is not None]

    @staticmethod
    def createCategories(values, symbol, layer=None, fieldName=""):
        return [QgsRendererCategory(v, symbol.clone() if symbol is not None else None, str(v)) for v in values]

    def _json(self):
        o = {"type": "categorized", "field": self._attr}
        if self._source is not None:
            o["symbol"] = self._source._json()
        if self._cats:
            o["categories"] = [c._json() for c in self._cats]
        if self._ramp is not None:
            o["ramp"] = self._ramp._json()
        return o

    def _bind(self, layer, result):
        self._layer = layer
        if result.get("categories"):
            base = result.get("symbol") or {}
            self._cats = [QgsRendererCategory(c.get("value"), QgsSymbol._from_json(dict(base, color=c.get("color"))), c.get("label"), c.get("enabled", True)) for c in result["categories"]]


class QgsGraduatedSymbolRenderer(QgsFeatureRenderer):
    _TYPE = "graduatedSymbol"
    EqualInterval, Quantile, Jenks, StdDev, Pretty, Custom = range(6)
    _LEGACY_MODES = {0: "equal_interval", 1: "quantile", 2: "jenks", 3: "stddev", 4: "pretty", 5: "custom"}

    def __init__(self, attrName="", ranges=None):
        super().__init__()
        self._attr, self._ranges, self._source, self._ramp, self._mode, self._classes = attrName, list(ranges or []), None, None, None, None

    def classAttribute(self):
        return self._attr

    def setClassAttribute(self, attr):
        self._attr = attr

    legendClassificationAttribute = classAttribute

    def ranges(self):
        return list(self._ranges)

    def addClass(self, rangeOrSymbol):
        if isinstance(rangeOrSymbol, QgsRendererRange):
            self._ranges.append(rangeOrSymbol)

    addClassRange = addClass

    def addClassLowerUpper(self, lower, upper):
        self._ranges.append(QgsRendererRange(lower, upper, self._source.clone() if self._source is not None else None))

    def deleteAllClasses(self):
        self._ranges = []

    def updateRangeLabel(self, index, label):
        self._ranges[index].setLabel(label)

    def updateRangeSymbol(self, index, symbol):
        self._ranges[index].setSymbol(symbol)

    def sourceSymbol(self):
        return self._source

    def setSourceSymbol(self, symbol):
        self._source = symbol

    def sourceColorRamp(self):
        return self._ramp

    def setSourceColorRamp(self, ramp):
        self._ramp = ramp

    def updateColorRamp(self, ramp=None):
        if ramp is not None:
            self._ramp = ramp
        for r in self._ranges:
            if r.symbol() is not None:
                r.symbol()._j.pop("color", None)

    def updateSymbols(self, symbol):
        self._source = symbol

    def setClassificationMethod(self, method):
        self._mode = _MODE_IDS.get(method.id(), "quantile") if method is not None else None

    def classificationMethod(self):
        ids = {v: k for k, v in _MODE_IDS.items()}
        m = QgsClassificationMethod()
        m._ID = ids.get(self._mode or "quantile", "Custom")
        return m

    def setMode(self, mode):
        self._mode = self._LEGACY_MODES.get(int(mode), "quantile")

    def mode(self):
        return {v: k for k, v in self._LEGACY_MODES.items()}.get(self._mode or "quantile", 1)

    def updateClasses(self, layer, nclasses=5, *a):
        """Classes are computed by QGIS when the renderer is applied (setRenderer); until then ranges() is empty."""
        if isinstance(nclasses, int) and nclasses > 0:
            self._classes = nclasses
        elif a and isinstance(a[0], int):
            self.setMode(nclasses)
            self._classes = a[0]
        self._ranges = []
        if layer is not None and layer.id():  # compute now, through QGIS, without touching the layer's renderer
            self._ranges = []
            preview = _bridge.call("layer_style_get", layer=layer.id())
            try:
                layer.setRenderer(self)
            finally:
                pass
            if preview.get("renderer") and preview["renderer"].get("type") == "single":
                pass  # the renderer is now this one; PyQGIS code calls setRenderer() again anyway

    def symbols(self, *a):
        return [r.symbol() for r in self._ranges if r.symbol() is not None]

    @staticmethod
    def createRenderer(vlayer, attrName, classes=5, mode=1, symbol=None, ramp=None, *a, **k):
        r = QgsGraduatedSymbolRenderer(attrName)
        r._source = symbol if symbol is not None else (QgsSymbol.defaultSymbol(vlayer.geometryType()) if vlayer is not None else None)
        r._ramp = ramp
        r._classes = int(classes)
        r._mode = r._LEGACY_MODES.get(int(mode), "quantile") if not isinstance(mode, QgsClassificationMethod) else _MODE_IDS.get(mode.id(), "quantile")
        return r

    def _json(self):
        o = {"type": "graduated", "field": self._attr}
        if self._source is not None:
            o["symbol"] = self._source._json()
        if self._ramp is not None:
            o["ramp"] = self._ramp._json()
        if self._ranges:
            o["ranges"] = [r._json() for r in self._ranges]
        else:
            o["classes"] = int(self._classes or 5)
            o["mode"] = self._mode or "quantile"
        return o

    def _bind(self, layer, result):
        self._layer = layer
        if result.get("ranges"):
            base = result.get("symbol") or {}
            self._ranges = [QgsRendererRange(c.get("lower", 0), c.get("upper", 0), QgsSymbol._from_json(dict(base, color=c.get("color"))), c.get("label"), c.get("enabled", True)) for c in result["ranges"]]
            self._mode = result.get("mode", self._mode)


class QgsTextBufferSettings:
    def __init__(self, data=None):
        self._j = {"enabled": False, "size": 1.0, "color": "#ffffff", "opacity": 1.0}
        self._j.update(data or {})

    def enabled(self):
        return bool(self._j.get("enabled"))

    def setEnabled(self, enabled):
        self._j["enabled"] = bool(enabled)

    def size(self):
        return float(self._j.get("size", 1.0))

    def setSize(self, size):
        self._j["size"] = float(size)

    def setSizeUnit(self, unit):
        pass

    def color(self):
        return QColor(self._j.get("color", "#ffffff"))

    def setColor(self, color):
        self._j["color"] = _color_name(color)

    def opacity(self):
        return float(self._j.get("opacity", 1.0))

    def setOpacity(self, opacity):
        self._j["opacity"] = float(opacity)

    def _json(self):
        return dict(self._j)


class QgsTextBackgroundSettings:
    ShapeRectangle, ShapeSquare, ShapeEllipse, ShapeCircle, ShapeSVG, ShapeMarkerSymbol = range(6)
    SizeBuffer, SizeFixed, SizePercent = range(3)

    def __init__(self, data=None):
        self._j = {"enabled": False, "fill_color": "#ffffff", "stroke_color": "#000000"}
        self._j.update(data or {})

    def enabled(self):
        return bool(self._j.get("enabled"))

    def setEnabled(self, enabled):
        self._j["enabled"] = bool(enabled)

    def fillColor(self):
        return QColor(self._j.get("fill_color", "#ffffff"))

    def setFillColor(self, color):
        self._j["fill_color"] = _color_name(color)

    def strokeColor(self):
        return QColor(self._j.get("stroke_color", "#000000"))

    def setStrokeColor(self, color):
        self._j["stroke_color"] = _color_name(color)

    def setStrokeWidth(self, w):
        self._j["stroke_width"] = float(w)

    def setRadii(self, radii):
        self._j["radius"] = float(radii.width() if hasattr(radii, "width") else (radii[0] if isinstance(radii, (list, tuple)) else radii))

    def setOpacity(self, opacity):
        self._j["opacity"] = float(opacity)

    def setType(self, *a):
        pass

    def setSizeType(self, *a):
        pass

    def setSize(self, *a):
        pass

    def _json(self):
        return dict(self._j)


class QgsTextFormat:
    def __init__(self, data=None):
        j = dict(data or {})
        self._size = float(j.get("size", 10))
        self._unit = _unit_value(j.get("size_unit", "points"))
        self._color = QColor(j.get("color", "#000000"))
        self._opacity = float(j.get("opacity", 1.0))
        self._font = QFont(j.get("font", ""), -1)
        self._font.setBold(bool(j.get("bold")))
        self._font.setItalic(bool(j.get("italic")))
        self._buffer = QgsTextBufferSettings(j.get("buffer"))
        self._background = QgsTextBackgroundSettings(j.get("background"))
        self._forced_bold = bool(j.get("bold"))
        self._forced_italic = bool(j.get("italic"))

    def size(self):
        return self._size

    def setSize(self, size):
        self._size = float(size)

    def sizeUnit(self):
        return self._unit

    def setSizeUnit(self, unit):
        self._unit = unit if isinstance(unit, int) else _unit_value(unit)

    def color(self):
        return self._color

    def setColor(self, color):
        self._color = QColor(color) if not isinstance(color, QColor) else color

    def opacity(self):
        return self._opacity

    def setOpacity(self, opacity):
        self._opacity = float(opacity)

    def font(self):
        return self._font

    def setFont(self, font):
        self._font = font

    def setNamedStyle(self, style):
        s = str(style).lower()
        self._font.setBold("bold" in s)
        self._font.setItalic("italic" in s or "oblique" in s)

    def forcedBold(self):
        return self._forced_bold

    def setForcedBold(self, forced):
        self._forced_bold = bool(forced)

    def forcedItalic(self):
        return self._forced_italic

    def setForcedItalic(self, forced):
        self._forced_italic = bool(forced)

    def buffer(self):
        return self._buffer

    def setBuffer(self, buffer):
        self._buffer = buffer

    def background(self):
        return self._background

    def setBackground(self, background):
        self._background = background

    def shadow(self):
        return QgsTextShadowSettings()

    def setShadow(self, *a):
        pass

    def isValid(self):
        return True

    def _json(self):
        o = {"size": self._size, "size_unit": _unit_name(self._unit), "color": _color_name(self._color), "opacity": self._opacity, "bold": self._font.bold() or self._forced_bold, "italic": self._font.italic() or self._forced_italic, "buffer": self._buffer._json(), "background": self._background._json()}
        if self._font.family():
            o["font"] = self._font.family()
        return o


class QgsTextShadowSettings:
    def setEnabled(self, *a):
        pass

    def enabled(self):
        return False


class QgsLabelPlacementSettings:
    def __init__(self, owner):
        self._o = owner

    def overlapHandling(self):
        return self._o._overlap

    def setOverlapHandling(self, handling):
        self._o._overlap = int(handling)

    def setAllowDegradedPlacement(self, allow):
        self._o._degraded = bool(allow)

    def allowDegradedPlacement(self):
        return self._o._degraded


class QgsPalLayerSettings:
    """Label settings. Public attributes as in PyQGIS: fieldName, isExpression, placement, priority, dist, xOffset,
    yOffset, scaleVisibility, minimumScale, maximumScale, wrapChar, autoWrapLength, multilineAlign, enabled, drawLabels."""

    AroundPoint, OverPoint, Line, Curved, Horizontal, Free, OrderedPositionsAroundPoint, PerimeterCurved, OutsidePolygons = range(9)
    MultiLeft, MultiCenter, MultiRight, MultiFollowPlacement, MultiJustify = range(5)
    Placement = Qgis.LabelPlacement

    def __init__(self, data=None):
        j = dict(data or {})
        self.fieldName = j.get("expression") or j.get("field") or ""
        self.isExpression = "expression" in j
        self.enabled = bool(j.get("enabled", True))
        self.drawLabels = True
        self.placement = _PLACEMENT_NAMES.index(j["placement"]) if j.get("placement") in _PLACEMENT_NAMES else self.AroundPoint
        self.priority = int(j.get("priority", 5))
        self.dist = float(j.get("distance", 0))
        off = j.get("offset") or [0, 0]
        self.xOffset, self.yOffset = float(off[0]), float(off[1]) if len(off) > 1 else 0.0
        self.scaleVisibility = "min_scale" in j or "max_scale" in j
        self.minimumScale = float(j.get("min_scale", 0))
        self.maximumScale = float(j.get("max_scale", 0))
        self.wrapChar = j.get("wrap_char", "")
        self.autoWrapLength = int(j.get("wrap_length", 0))
        self.multilineAlign = _ALIGN_NAMES.index(j["align"]) if j.get("align") in _ALIGN_NAMES else self.MultiFollowPlacement
        self.displayAll = False
        self._overlap = _OVERLAP_NAMES.index(j["overlap"]) if j.get("overlap") in _OVERLAP_NAMES else 0
        self._degraded = False
        self._format = QgsTextFormat(j)
        self._placement_settings = QgsLabelPlacementSettings(self)

    @classmethod
    def _from_json(cls, j):
        return cls(j)

    def format(self):
        return self._format

    def setFormat(self, fmt):
        self._format = fmt

    def placementSettings(self):
        return self._placement_settings

    def thinningSettings(self):
        return self._placement_settings

    def setDataDefinedProperties(self, *a):
        pass

    def dataDefinedProperties(self):
        return None

    def _json(self):
        o = {"enabled": bool(self.enabled), ("expression" if self.isExpression else "field"): self.fieldName}
        o.update(self._format._json())
        o["placement"] = _PLACEMENT_NAMES[int(self.placement)] if 0 <= int(self.placement) < len(_PLACEMENT_NAMES) else "around_point"
        o["priority"] = int(self.priority)
        o["distance"] = float(self.dist)
        o["offset"] = [float(self.xOffset), float(self.yOffset)]
        o["overlap"] = _OVERLAP_NAMES[self._overlap] if 0 <= self._overlap < 3 else "prevent"
        if self.displayAll:
            o["show_all"] = True
        if self.scaleVisibility:
            o["min_scale"], o["max_scale"] = float(self.minimumScale), float(self.maximumScale)
        else:
            o["min_scale"], o["max_scale"] = 0, 0
        if self.wrapChar:
            o["wrap_char"] = self.wrapChar
        if self.autoWrapLength:
            o["wrap_length"] = int(self.autoWrapLength)
        if int(self.multilineAlign) != self.MultiFollowPlacement:
            o["align"] = _ALIGN_NAMES[int(self.multilineAlign)]
        return o


class QgsAbstractVectorLayerLabeling:
    def type(self):
        return ""


class QgsVectorLayerSimpleLabeling(QgsAbstractVectorLayerLabeling):
    def __init__(self, settings):
        self._settings = settings

    def type(self):
        return "simple"

    def settings(self, providerId=None):
        return self._settings

    def setSettings(self, settings, providerId=None):
        self._settings = settings

    def clone(self):
        return QgsVectorLayerSimpleLabeling(self._settings)

    def _json(self):
        return self._settings._json()


class QgsUnitTypes:
    RenderMillimeters, RenderMapUnits, RenderPixels, RenderPercentage, RenderPoints, RenderInches, RenderUnknownUnit, RenderMetersInMapUnits = range(8)
    DistanceMeters, DistanceKilometers, DistanceFeet, DistanceNauticalMiles, DistanceYards, DistanceMiles, DistanceDegrees, DistanceCentimeters, DistanceMillimeters, DistanceUnknownUnit = range(10)


# --- names outside the subset: say so instead of a bare ImportError ----------------------------------------------------
_HINTS = {
    "QgsRuleBasedRenderer": "rule based symbology: build it in the layer properties dialog, or apply a QML with the rules (layer.importNamedStyle(qml_text) / bridge tool layer_style_qml)",
    "QgsRuleBasedLabeling": "rule based labels: apply a QML (layer.importNamedStyle) or use QgsVectorLayerSimpleLabeling with an expression",
    "QgsHeatmapRenderer": "heatmaps: run processing 'native:heatmapkerneldensityestimation' or apply a QML with the renderer",
    "QgsSvgMarkerSymbolLayer": "SVG markers: apply a QML with the symbol (layer.importNamedStyle); QgsMarkerSymbol supports simple shapes",
    "QgsRasterShader": "raster styling: apply a QML (layer.importNamedStyle)",
    "QgsSingleBandPseudoColorRenderer": "raster styling: apply a QML (layer.importNamedStyle)",
}


def __getattr__(name):
    if name.startswith("__"):
        raise AttributeError(name)
    hint = _HINTS.get(name)
    message = (
        f"qgis.core.{name} is not part of the browser PyQGIS compatibility layer. "
        + (f"{hint}. " if hint else "")
        + "Available for styling: QgsSymbol / QgsMarkerSymbol / QgsLineSymbol / QgsFillSymbol, QgsSingleSymbolRenderer, "
        "QgsCategorizedSymbolRenderer + QgsRendererCategory, QgsGraduatedSymbolRenderer + QgsRendererRange, QgsGradientColorRamp, "
        "QgsStyle.defaultStyle().colorRamp(name), QgsPalLayerSettings, QgsTextFormat, QgsTextBufferSettings, QgsVectorLayerSimpleLabeling; "
        "layer.setRenderer() / setLabeling() / setLabelsEnabled() / loadNamedStyle() / importNamedStyle(qml). "
        "Anything else: the bridge tools qgis._bridge.call('layer_style_set', layer=..., renderer={...}, labels={...}) and layer_style_qml — see docs/03."
    )
    # `from qgis.core import X` turns an AttributeError into a bare "cannot import name"; raise ImportError there so the hint survives
    try:
        import dis
        import sys

        frame = sys._getframe(1)
        if frame.f_code.co_code[frame.f_lasti] == dis.opmap["IMPORT_FROM"]:
            raise ImportError(message, name=__name__)
    except (ValueError, IndexError, KeyError, AttributeError):
        pass
    raise AttributeError(message)
