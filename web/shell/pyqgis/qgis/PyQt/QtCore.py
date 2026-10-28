"""qgis.PyQt.QtCore — the small part of Qt that plugin *logic* needs: QObject, signals, Qt namespace, QTimer, QVariant."""
from .. import _bridge


class _BoundSignal:
    def __init__(self, owner, name):
        self._owner, self._name = owner, name
        self._slots = []

    def connect(self, slot):
        self._slots.append(slot)
        return True

    def disconnect(self, slot=None):
        if slot is None:
            self._slots.clear()
        else:
            try:
                self._slots.remove(slot)
            except ValueError:
                pass

    def emit(self, *args):
        for slot in list(self._slots):
            try:
                slot(*args)
            except TypeError as e:
                # Qt drops extra arguments for slots with fewer parameters
                if "positional argument" in str(e) and args:
                    try:
                        slot(*args[:-1]) if len(args) > 1 else slot()
                        continue
                    except TypeError:
                        pass
                raise
            except Exception as e:  # noqa: BLE001
                import traceback

                _bridge.log(f"slot for {self._name} failed: {e}\n{traceback.format_exc()}", "Python", "critical")

    __call__ = emit


class pyqtSignal:
    """Class-level signal declaration; per-instance bound signals are created on first access."""

    def __init__(self, *types, name=None):
        self._types = types
        self._name = name

    def __set_name__(self, owner, name):
        self._name = self._name or name

    def __get__(self, instance, owner):
        if instance is None:
            return self
        store = instance.__dict__.setdefault("_bound_signals", {})
        if self._name not in store:
            store[self._name] = _BoundSignal(instance, self._name)
        return store[self._name]


Signal = pyqtSignal


def pyqtSlot(*args, **kwargs):
    def deco(fn):
        return fn

    return deco


Slot = pyqtSlot


class QObject:
    objectNameChanged = pyqtSignal(str)
    destroyed = pyqtSignal()

    def __init__(self, parent=None, *args, **kwargs):
        self._parent = parent
        self._object_name = ""
        self._properties = {}

    def parent(self):
        return self._parent

    def setParent(self, parent):
        self._parent = parent

    def objectName(self):
        return self._object_name

    def setObjectName(self, name):
        self._object_name = name
        self.objectNameChanged.emit(name)

    def property(self, name):
        return self._properties.get(name)

    def setProperty(self, name, value):
        self._properties[name] = value
        return True

    def deleteLater(self):
        self.destroyed.emit()

    def blockSignals(self, block):
        return False

    def tr(self, text, *args):
        return text

    def isWidgetType(self):
        return False

    def thread(self):
        return None


class QCoreApplication:
    @staticmethod
    def translate(context, text, disambiguation=None, n=-1):
        return text

    @staticmethod
    def instance():
        return QCoreApplication

    @staticmethod
    def processEvents(*args):
        pass

    @staticmethod
    def applicationName():
        return "QGIS"

    @staticmethod
    def organizationName():
        return "QGIS"


class Qt:
    LeftButton, RightButton, MiddleButton = 1, 2, 4
    NoButton = 0
    Unchecked, PartiallyChecked, Checked = 0, 1, 2
    Horizontal, Vertical = 1, 2
    LeftDockWidgetArea, RightDockWidgetArea, TopDockWidgetArea, BottomDockWidgetArea = 1, 2, 4, 8
    AlignLeft, AlignRight, AlignHCenter, AlignTop, AlignBottom, AlignVCenter, AlignCenter = 1, 2, 4, 32, 64, 128, 132
    Key_Escape, Key_Return, Key_Enter, Key_Delete = 0x01000000, 0x01000004, 0x01000005, 0x01000007
    WindowModal, ApplicationModal, NonModal = 1, 2, 0
    UserRole, DisplayRole, EditRole, ToolTipRole = 256, 0, 2, 3
    ArrowCursor, CrossCursor, WaitCursor, PointingHandCursor = 0, 2, 3, 13
    white, black, red, green, blue, yellow, transparent = "white", "black", "red", "green", "blue", "yellow", "transparent"

    class ItemDataRole:
        UserRole, DisplayRole, EditRole = 256, 0, 2

    class CheckState:
        Unchecked, PartiallyChecked, Checked = 0, 1, 2

    class MouseButton:
        LeftButton, RightButton, MiddleButton = 1, 2, 4

    class DockWidgetArea:
        LeftDockWidgetArea, RightDockWidgetArea, TopDockWidgetArea, BottomDockWidgetArea = 1, 2, 4, 8


class QVariant:
    Invalid, Bool, Int, Double, String, List, Map, Date, DateTime, LongLong = 0, 1, 2, 6, 10, 9, 8, 14, 16, 4

    def __init__(self, value=None):
        self._v = value

    def value(self):
        return self._v

    def isNull(self):
        return self._v is None

    def toString(self):
        return "" if self._v is None else str(self._v)

    def toInt(self):
        try:
            return int(self._v), True
        except Exception:  # noqa: BLE001
            return 0, False

    def toBool(self):
        return bool(self._v)


NULL = None


class QTimer(QObject):
    """Timers run on the page's event loop; callbacks are re-entered through the runtime so they may use the bridge."""

    timeout = pyqtSignal()
    _pending = {}
    _next = 1

    def __init__(self, parent=None):
        super().__init__(parent)
        self._interval = 0
        self._single = False
        self._token = None

    @staticmethod
    def singleShot(msec, slot):
        token = QTimer._next
        QTimer._next += 1
        QTimer._pending[token] = slot
        if _bridge.IN_PYODIDE:
            _bridge.js.qgisPython.timer(int(msec), token)
        return token

    @staticmethod
    def _fire(token):
        slot = QTimer._pending.pop(token, None)
        if slot is not None:
            slot()

    def setInterval(self, msec):
        self._interval = int(msec)

    def interval(self):
        return self._interval

    def setSingleShot(self, single):
        self._single = bool(single)

    def isActive(self):
        return self._token is not None

    def start(self, msec=None):
        if msec is not None:
            self._interval = int(msec)
        self.stop()

        def tick():
            self._token = None
            self.timeout.emit()
            if not self._single and self._active:
                self.start()

        self._active = True
        self._token = QTimer.singleShot(self._interval, tick)

    def stop(self):
        self._active = False
        if self._token is not None:
            QTimer._pending.pop(self._token, None)
            self._token = None


class QSize:
    def __init__(self, w=0, h=0):
        self._w, self._h = w, h

    def width(self):
        return self._w

    def height(self):
        return self._h


class QPoint:
    def __init__(self, x=0, y=0):
        self._x, self._y = x, y

    def x(self):
        return self._x

    def y(self):
        return self._y


class QPointF(QPoint):
    pass


class QRectF:
    def __init__(self, x=0.0, y=0.0, w=0.0, h=0.0):
        self._x, self._y, self._w, self._h = x, y, w, h

    def x(self):
        return self._x

    def y(self):
        return self._y

    def width(self):
        return self._w

    def height(self):
        return self._h


class QUrl:
    def __init__(self, url=""):
        self._url = str(url)

    def toString(self):
        return self._url

    def isValid(self):
        return bool(self._url)

    @staticmethod
    def fromLocalFile(path):
        return QUrl("file://" + path)


class QDate:
    @staticmethod
    def currentDate():
        import datetime

        return datetime.date.today()


class QDateTime:
    @staticmethod
    def currentDateTime():
        import datetime

        return datetime.datetime.now()


class QLocale:
    @staticmethod
    def system():
        return QLocale()

    def name(self):
        return "en_US"


class QStandardPaths:
    @staticmethod
    def writableLocation(kind):
        return "/home/web_user"


class QFileInfo:
    def __init__(self, path=""):
        import os

        self._p = path
        self._os = os

    def exists(self):
        return self._os.path.exists(self._p)

    def fileName(self):
        return self._os.path.basename(self._p)

    def baseName(self):
        return self.fileName().split(".", 1)[0]

    def completeBaseName(self):
        return self.fileName().rsplit(".", 1)[0]

    def suffix(self):
        return self.fileName().rsplit(".", 1)[-1] if "." in self.fileName() else ""

    def absolutePath(self):
        return self._os.path.dirname(self._os.path.abspath(self._p))

    def absoluteFilePath(self):
        return self._os.path.abspath(self._p)

    def isDir(self):
        return self._os.path.isdir(self._p)

    def isFile(self):
        return self._os.path.isfile(self._p)


QT_VERSION_STR = "6.11.1"
PYQT_VERSION_STR = "6.0.0-qgis-wasm"
QT_VERSION = 0x060B01
