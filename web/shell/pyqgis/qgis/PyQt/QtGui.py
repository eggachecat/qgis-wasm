"""qgis.PyQt.QtGui — QIcon, QColor, QAction (Qt 6 location), QKeySequence, QCursor as data holders."""
from .. import _bridge
from .QtCore import QObject, pyqtSignal


class QIcon:
    def __init__(self, path=None):
        self._path = path if isinstance(path, str) else ""

    def isNull(self):
        return not self._path

    def name(self):
        return self._path

    def _qgis_path(self):
        return _bridge.qgis_path(self._path)

    @staticmethod
    def fromTheme(name, fallback=None):
        return QIcon(name)


class QColor:
    HexRgb, HexArgb, HexArgbCss = 0, 1, 2
    _NAMES = {"red": (255, 0, 0), "green": (0, 128, 0), "blue": (0, 0, 255), "black": (0, 0, 0), "white": (255, 255, 255), "yellow": (255, 255, 0), "orange": (255, 165, 0), "gray": (128, 128, 128), "grey": (128, 128, 128), "cyan": (0, 255, 255), "magenta": (255, 0, 255), "purple": (128, 0, 128), "pink": (255, 192, 203), "brown": (165, 42, 42), "darkred": (139, 0, 0), "darkgreen": (0, 100, 0), "darkblue": (0, 0, 139), "lightgray": (211, 211, 211), "lightgrey": (211, 211, 211), "transparent": (0, 0, 0, 0)}

    def __init__(self, *args):
        self._r, self._g, self._b, self._a = 0, 0, 0, 255
        if len(args) == 1 and isinstance(args[0], QColor):
            self._r, self._g, self._b, self._a = args[0]._r, args[0]._g, args[0]._b, args[0]._a
        elif len(args) == 1 and isinstance(args[0], str):
            self._parse(args[0])
        elif len(args) >= 3:
            self._r, self._g, self._b = (max(0, min(255, int(v))) for v in args[:3])
            self._a = max(0, min(255, int(args[3]))) if len(args) > 3 else 255
        elif len(args) == 1 and isinstance(args[0], int):  # Qt.GlobalColor numbers are not supported: black
            pass

    def _parse(self, text):
        s = str(text).strip()
        import re

        m = re.match(r"^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$", s)
        if m:
            self._r, self._g, self._b = int(m.group(1)), int(m.group(2)), int(m.group(3))
            self._a = int(round(min(1.0, max(0.0, float(m.group(4)))) * 255)) if m.group(4) else 255
            return
        if s.startswith("#"):
            h = s[1:]
            if len(h) in (3, 4):
                h = "".join(ch * 2 for ch in h)
            if len(h) == 6:
                self._r, self._g, self._b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
            elif len(h) == 8:  # CSS #rrggbbaa (the bridge's notation)
                self._r, self._g, self._b, self._a = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(h[6:8], 16)
            return
        rgb = self._NAMES.get(s.lower())
        if rgb:
            self._r, self._g, self._b = rgb[:3]
            self._a = rgb[3] if len(rgb) > 3 else 255
        else:
            self._invalid = True

    @staticmethod
    def fromRgb(r, g, b, a=255):
        return QColor(r, g, b, a)

    @staticmethod
    def fromRgbF(r, g, b, a=1.0):
        return QColor(int(r * 255), int(g * 255), int(b * 255), int(a * 255))

    @staticmethod
    def fromString(text):
        return QColor(text)

    def name(self, fmt=0):
        if fmt == QColor.HexArgb:
            return f"#{self._a:02x}{self._r:02x}{self._g:02x}{self._b:02x}"
        if fmt == QColor.HexArgbCss and self._a != 255:
            return f"#{self._r:02x}{self._g:02x}{self._b:02x}{self._a:02x}"
        return f"#{self._r:02x}{self._g:02x}{self._b:02x}"

    def isValid(self):
        return not getattr(self, "_invalid", False)

    def red(self):
        return self._r

    def green(self):
        return self._g

    def blue(self):
        return self._b

    def alpha(self):
        return self._a

    def alphaF(self):
        return self._a / 255.0

    def redF(self):
        return self._r / 255.0

    def greenF(self):
        return self._g / 255.0

    def blueF(self):
        return self._b / 255.0

    def setRed(self, v):
        self._r = int(v)

    def setGreen(self, v):
        self._g = int(v)

    def setBlue(self, v):
        self._b = int(v)

    def setAlpha(self, v):
        self._a = max(0, min(255, int(v)))

    def setAlphaF(self, v):
        self._a = int(round(max(0.0, min(1.0, float(v))) * 255))

    def setNamedColor(self, text):
        self._parse(text)

    def lighter(self, factor=150):
        f = factor / 100.0
        return QColor(min(255, int(self._r * f)), min(255, int(self._g * f)), min(255, int(self._b * f)), self._a)

    def darker(self, factor=200):
        f = 100.0 / factor
        return QColor(int(self._r * f), int(self._g * f), int(self._b * f), self._a)

    def __eq__(self, other):
        return isinstance(other, QColor) and (self._r, self._g, self._b, self._a) == (other._r, other._g, other._b, other._a)

    def __hash__(self):
        return hash((self._r, self._g, self._b, self._a))

    def __repr__(self):
        return f"<QColor {self.name(QColor.HexArgbCss)}>"


class QKeySequence:
    def __init__(self, seq=""):
        self._seq = str(seq)

    def toString(self, *a):
        return self._seq


class QCursor:
    def __init__(self, shape=0):
        self._shape = shape


class QFont:
    Thin, ExtraLight, Light, Normal, Medium, DemiBold, Bold, ExtraBold, Black = 100, 200, 300, 400, 500, 600, 700, 800, 900
    StyleNormal, StyleItalic, StyleOblique = 0, 1, 2

    def __init__(self, family="", pointSize=-1, weight=-1, italic=False):
        if isinstance(family, QFont):
            self._family, self._size, self._weight, self._italic = family._family, family._size, family._weight, family._italic
            return
        self._family, self._size, self._weight, self._italic = family, pointSize, (weight if weight > 0 else 400), bool(italic)

    def family(self):
        return self._family

    def setFamily(self, family):
        self._family = family

    def pointSize(self):
        return int(self._size)

    def pointSizeF(self):
        return float(self._size)

    def setPointSize(self, size):
        self._size = size

    setPointSizeF = setPointSize

    def pixelSize(self):
        return int(self._size)

    def setPixelSize(self, size):
        self._size = size

    def bold(self):
        return self._weight >= 600

    def setBold(self, bold):
        self._weight = 700 if bold else 400

    def weight(self):
        return self._weight

    def setWeight(self, weight):
        self._weight = int(weight) if int(weight) > 99 else {0: 100, 12: 200, 25: 300, 50: 400, 57: 500, 63: 600, 75: 700, 81: 800, 87: 900}.get(int(weight), 400)

    def italic(self):
        return self._italic

    def setItalic(self, italic):
        self._italic = bool(italic)

    def setStyle(self, style):
        self._italic = style in (1, 2)

    def setUnderline(self, *a):
        pass

    def setStyleName(self, name):
        self.setBold("bold" in str(name).lower())
        self.setItalic("italic" in str(name).lower())

    def __repr__(self):
        return f"<QFont {self._family!r} {self._size} w{self._weight}{' italic' if self._italic else ''}>"


class QPixmap:
    def __init__(self, path=""):
        self._path = path if isinstance(path, str) else ""

    def isNull(self):
        return not self._path


class QDesktopServices:
    @staticmethod
    def openUrl(url):
        _bridge.js.window.open(url.toString() if hasattr(url, "toString") else str(url), "_blank")
        return True


class QAction(QObject):
    """A menu / toolbar action. Added to QGIS through QgisInterface (ui_add_action); the real QGIS menu triggers it."""

    triggered = pyqtSignal(bool)
    toggled = pyqtSignal(bool)
    changed = pyqtSignal()

    _registry = {}  # bridge action id → QAction
    _next_id = 1

    def __init__(self, *args, **kwargs):
        icon, text, parent = QIcon(), "", None
        for a in args:
            if isinstance(a, QIcon):
                icon = a
            elif isinstance(a, str):
                text = a
            else:
                parent = a
        text = kwargs.get("text", text)
        parent = kwargs.get("parent", parent)
        super().__init__(parent)
        self._icon, self._text = icon, text
        self._checkable, self._checked, self._enabled, self._visible = False, False, True, True
        self._tooltip, self._status_tip, self._whats_this = "", "", ""
        self._shortcut = None
        self._bridge_id = None  # set when added to a QGIS menu / toolbar
        self._menu = None
        self._in_toolbar = False

    # --- properties
    def text(self):
        return self._text

    def setText(self, text):
        self._text = text
        self._sync()

    def icon(self):
        return self._icon

    def setIcon(self, icon):
        self._icon = icon if isinstance(icon, QIcon) else QIcon(icon)
        self._sync()

    def isCheckable(self):
        return self._checkable

    def setCheckable(self, checkable):
        self._checkable = bool(checkable)

    def isChecked(self):
        return self._checked

    def setChecked(self, checked):
        if self._checked != bool(checked):
            self._checked = bool(checked)
            self.toggled.emit(self._checked)

    def isEnabled(self):
        return self._enabled

    def setEnabled(self, enabled):
        self._enabled = bool(enabled)

    def setDisabled(self, disabled):
        self._enabled = not disabled

    def isVisible(self):
        return self._visible

    def setVisible(self, visible):
        self._visible = bool(visible)

    def toolTip(self):
        return self._tooltip

    def setToolTip(self, tip):
        self._tooltip = tip

    def setStatusTip(self, tip):
        self._status_tip = tip

    def setWhatsThis(self, text):
        self._whats_this = text

    def setShortcut(self, shortcut):
        self._shortcut = shortcut

    def shortcut(self):
        return self._shortcut

    def setData(self, data):
        self._data = data

    def data(self):
        return getattr(self, "_data", None)

    def setMenu(self, menu):
        self._submenu = menu

    # --- behaviour
    def trigger(self):
        if not self._enabled:
            return
        if self._checkable:
            self.setChecked(not self._checked)
        self.triggered.emit(self._checked)

    activate = trigger

    def _ensure_registered(self, menu=None, toolbar=False):
        if self._bridge_id is None:
            self._bridge_id = f"py:{QAction._next_id}"
            QAction._next_id += 1
            QAction._registry[self._bridge_id] = self
        if menu is not None:
            self._menu = menu
        if toolbar:
            self._in_toolbar = True
        self._sync()

    def _sync(self):
        if self._bridge_id is None:
            return
        _bridge.call("ui_add_action", id=self._bridge_id, text=self._text or "Action", menu=self._menu or "Python Plugins", toolbar=bool(self._in_toolbar), icon=self._icon._qgis_path() or None)

    def _unregister(self):
        if self._bridge_id is not None:
            try:
                _bridge.call("ui_remove_action", id=self._bridge_id)
            except Exception:  # noqa: BLE001
                pass
            QAction._registry.pop(self._bridge_id, None)
            self._bridge_id = None

    @staticmethod
    def _dispatch(action_id):
        action = QAction._registry.get(action_id)
        if action is not None:
            action.trigger()
            return True
        return False


# events from QGIS: a Python-registered menu entry / toolbar button was clicked
_bridge.subscribe("action", lambda payload: QAction._dispatch(payload.get("id")))
