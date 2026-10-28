"""
qgis.PyQt.QtWidgets — what plugin code touches outside of its own dialogs.

QGIS' own widgets are C++ inside the WebAssembly module and cannot be built from Python here, so:
  * QMessageBox / QInputDialog / QFileDialog map to the browser's native blocking dialogs (alert / confirm / prompt),
  * QAction / QMenu / QToolBar work (they become entries of the real QGIS Plugins menu and toolbar),
  * custom QDialog / QWidget subclasses and uic.loadUi raise NotImplementedError with the alternatives.
"""
from .. import _bridge
from .QtCore import QObject, Qt, pyqtSignal
from .QtGui import QAction, QIcon  # noqa: F401  (Qt5 code imports QAction from QtWidgets)


def _js():
    return _bridge.js


class QWidget(QObject):
    """Placeholder for parents / main window references. Not a real window."""

    def __init__(self, parent=None, *a, **k):
        super().__init__(parent)
        self._title = ""
        self._visible = False

    def setWindowTitle(self, t):
        self._title = t

    def windowTitle(self):
        return self._title

    def show(self):
        raise NotImplementedError("Custom Qt widgets cannot be created from Python in the browser QGIS. Use the QGIS dialogs through the toolbar, browser prompts (QInputDialog/QMessageBox), or a web plugin (docs/03).")

    def hide(self):
        self._visible = False

    def isVisible(self):
        return self._visible

    def setEnabled(self, e):
        pass

    def setLayout(self, layout):
        pass

    def setMinimumSize(self, *a):
        pass

    def resize(self, *a):
        pass

    def close(self):
        return True

    def repaint(self):
        pass

    def update(self):
        pass

    def setCursor(self, c):
        pass

    def unsetCursor(self):
        pass


class QMainWindow(QWidget):
    def statusBar(self):
        return _StatusBar()

    def menuBar(self):
        return _MenuBar()


class _StatusBar:
    def showMessage(self, text, timeout=0):
        _bridge.call("ui_message", text=str(text), duration=max(1, int(timeout / 1000)) if timeout else 4)


class _MenuBar:
    def addMenu(self, title):
        return QMenu(title if isinstance(title, str) else getattr(title, "_title", "Menu"))


class QDialog(QWidget):
    accepted = pyqtSignal()
    rejected = pyqtSignal()
    finished = pyqtSignal(int)
    Accepted, Rejected = 1, 0

    def exec(self):
        raise NotImplementedError("QDialog.exec(): custom dialogs cannot be built from Python in the browser QGIS; use QInputDialog/QMessageBox (browser prompts) or a web plugin for rich UI.")

    exec_ = exec

    def accept(self):
        self.accepted.emit()
        self.finished.emit(1)

    def reject(self):
        self.rejected.emit()
        self.finished.emit(0)


class QDockWidget(QWidget):
    def __init__(self, title="", parent=None):
        super().__init__(parent)
        self._title = title

    def setWidget(self, w):
        pass


class QMenu(QObject):
    def __init__(self, title="", parent=None):
        super().__init__(parent)
        self._title = title if isinstance(title, str) else ""
        self._actions = []

    def title(self):
        return self._title

    def setTitle(self, t):
        self._title = t

    def addAction(self, *args):
        action = args[0] if args and isinstance(args[0], QAction) else QAction(*args)
        action._ensure_registered(menu=self._title or "Python Plugins")
        self._actions.append(action)
        return action

    def addActions(self, actions):
        for a in actions:
            self.addAction(a)

    def addMenu(self, menu):
        return menu if isinstance(menu, QMenu) else QMenu(menu)

    def addSeparator(self):
        return None

    def removeAction(self, action):
        action._unregister()
        if action in self._actions:
            self._actions.remove(action)

    def actions(self):
        return list(self._actions)

    def clear(self):
        for a in list(self._actions):
            self.removeAction(a)

    def menuAction(self):
        return QAction(self._title)


class QToolBar(QObject):
    def __init__(self, title="", parent=None):
        super().__init__(parent)
        self._title = title if isinstance(title, str) else ""
        self._actions = []

    def addAction(self, *args):
        action = args[0] if args and isinstance(args[0], QAction) else QAction(*args)
        action._ensure_registered(menu=self._title or "Python Plugins", toolbar=True)
        self._actions.append(action)
        return action

    def removeAction(self, action):
        action._unregister()

    def addSeparator(self):
        return None

    def addWidget(self, widget):
        return None

    def setObjectName(self, n):
        self._object_name = n

    def actions(self):
        return list(self._actions)


class QMessageBox(QWidget):
    Ok, Cancel, Yes, No, Save, Discard, Close = 0x400, 0x400000, 0x4000, 0x10000, 0x800, 0x800000, 0x200000
    NoButton = 0
    Information, Warning, Critical, Question = 1, 2, 3, 4

    class StandardButton:
        Ok, Cancel, Yes, No = 0x400, 0x400000, 0x4000, 0x10000

    @staticmethod
    def _show(level, title, text):
        _js().window.alert(f"{title}\n\n{text}" if title else text)
        try:
            _bridge.call("ui_message", title=str(title), text=str(text), level=level, duration=8)
        except Exception:  # noqa: BLE001
            pass
        return QMessageBox.Ok

    @staticmethod
    def information(parent, title, text, *a, **k):
        return QMessageBox._show("info", title, text)

    @staticmethod
    def warning(parent, title, text, *a, **k):
        return QMessageBox._show("warning", title, text)

    @staticmethod
    def critical(parent, title, text, *a, **k):
        return QMessageBox._show("critical", title, text)

    @staticmethod
    def about(parent, title, text):
        return QMessageBox._show("info", title, text)

    @staticmethod
    def question(parent, title, text, buttons=None, defaultButton=None):
        ok = bool(_js().window.confirm(f"{title}\n\n{text}" if title else text))
        return QMessageBox.Yes if ok else QMessageBox.No

    # instance style usage: box = QMessageBox(); box.setText(...); box.exec()
    def __init__(self, *a, **k):
        super().__init__()
        self._text, self._info, self._icon = "", "", QMessageBox.Information

    def setText(self, t):
        self._text = t

    def setInformativeText(self, t):
        self._info = t

    def setIcon(self, icon):
        self._icon = icon

    def setStandardButtons(self, b):
        self._buttons = b

    def setDefaultButton(self, b):
        pass

    def exec(self):
        text = self._text + ("\n" + self._info if self._info else "")
        if getattr(self, "_buttons", 0) & (QMessageBox.Yes | QMessageBox.Cancel | QMessageBox.No):
            return QMessageBox.Yes if _js().window.confirm(text) else QMessageBox.No
        _js().window.alert(text)
        return QMessageBox.Ok

    exec_ = exec


class QInputDialog:
    @staticmethod
    def getText(parent, title, label, echo=None, text="", *a, **k):
        r = _js().window.prompt(f"{title}\n{label}" if title else label, text or "")
        return ("" if r is None else str(r), r is not None)

    @staticmethod
    def getMultiLineText(parent, title, label, text="", *a, **k):
        return QInputDialog.getText(parent, title, label, None, text)

    @staticmethod
    def getInt(parent, title, label, value=0, min=-2147483647, max=2147483647, step=1, *a, **k):
        r = _js().window.prompt(f"{title}\n{label}" if title else label, str(value))
        try:
            return (int(r), True) if r is not None else (value, False)
        except ValueError:
            return (value, False)

    @staticmethod
    def getDouble(parent, title, label, value=0.0, min=-1e300, max=1e300, decimals=1, *a, **k):
        r = _js().window.prompt(f"{title}\n{label}" if title else label, str(value))
        try:
            return (float(r), True) if r is not None else (value, False)
        except ValueError:
            return (value, False)

    @staticmethod
    def getItem(parent, title, label, items, current=0, editable=True, *a, **k):
        items = list(items)
        listing = "\n".join(f"{i + 1}. {it}" for i, it in enumerate(items))
        r = _js().window.prompt(f"{title}\n{label}\n{listing}\n(number or text)", str(items[current]) if items else "")
        if r is None:
            return ("", False)
        r = str(r).strip()
        if r.isdigit() and 1 <= int(r) <= len(items):
            return (items[int(r) - 1], True)
        return (r, True)


class QFileDialog:
    """There is no native file dialog in the page; ask for a virtual filesystem path (e.g. /cloud/<mount>/data.gpkg)."""

    @staticmethod
    def getOpenFileName(parent=None, caption="", directory="", filter="", *a, **k):
        r = _js().window.prompt(f"{caption or 'Open file'}\nPath in the QGIS virtual filesystem (/cloud/…, /home/web_user/…):", directory or "/cloud/")
        return ("" if r is None else str(r), filter)

    @staticmethod
    def getOpenFileNames(parent=None, caption="", directory="", filter="", *a, **k):
        name, f = QFileDialog.getOpenFileName(parent, caption, directory, filter)
        return ([name] if name else [], f)

    @staticmethod
    def getSaveFileName(parent=None, caption="", directory="", filter="", *a, **k):
        r = _js().window.prompt(f"{caption or 'Save file'}\nPath in the QGIS virtual filesystem (/cloud/…, /home/web_user/…):", directory or "/home/web_user/")
        return ("" if r is None else str(r), filter)

    @staticmethod
    def getExistingDirectory(parent=None, caption="", directory="", *a, **k):
        r = _js().window.prompt(f"{caption or 'Choose directory'}\nDirectory in the QGIS virtual filesystem:", directory or "/home/web_user/")
        return "" if r is None else str(r)


class QApplication(QObject):
    @staticmethod
    def instance():
        return QApplication

    @staticmethod
    def processEvents(*a):
        pass

    @staticmethod
    def setOverrideCursor(c):
        pass

    @staticmethod
    def restoreOverrideCursor():
        pass

    @staticmethod
    def clipboard():
        return _Clipboard()

    @staticmethod
    def activeWindow():
        return None

    @staticmethod
    def translate(ctx, text, *a):
        return text


class _Clipboard:
    def setText(self, text):
        try:
            _js().navigator.clipboard.writeText(str(text))
        except Exception:  # noqa: BLE001
            pass

    def text(self):
        return ""


class QProgressDialog(QWidget):
    canceled = pyqtSignal()

    def __init__(self, label="", cancel="", minimum=0, maximum=100, parent=None, *a, **k):
        super().__init__(parent)
        self._label, self._max = label, maximum

    def setValue(self, v):
        if self._max:
            _bridge.call("ui_message", title=self._label or "Progress", text=f"{int(100 * v / self._max)} %", duration=1)

    def setLabelText(self, t):
        self._label = t

    def wasCanceled(self):
        return False

    def setWindowModality(self, m):
        pass

    def setMinimumDuration(self, d):
        pass


# layout / widget placeholders so that `from qgis.PyQt.QtWidgets import *` style imports do not fail at import time
class _Unavailable(QWidget):
    def __init__(self, *a, **k):
        raise NotImplementedError(f"{type(self).__name__} cannot be created from Python in the browser QGIS (see docs/03 for alternatives)")


for _name in ["QLabel", "QPushButton", "QLineEdit", "QComboBox", "QCheckBox", "QTextEdit", "QPlainTextEdit", "QSpinBox", "QDoubleSpinBox", "QListWidget", "QTableWidget", "QTreeWidget", "QTabWidget", "QGroupBox", "QFrame", "QScrollArea", "QSplitter", "QStackedWidget", "QVBoxLayout", "QHBoxLayout", "QGridLayout", "QFormLayout", "QDialogButtonBox", "QRadioButton", "QSlider", "QProgressBar", "QToolButton", "QListWidgetItem", "QTableWidgetItem", "QTreeWidgetItem", "QHeaderView", "QSizePolicy", "QSpacerItem", "QButtonGroup", "QColorDialog", "QFontDialog", "QWizard", "QWizardPage", "QDateEdit", "QDateTimeEdit", "QTimeEdit", "QCalendarWidget", "QTextBrowser", "QStatusBar", "QMenuBar", "QAbstractItemView", "QStyle", "QStyleFactory", "QShortcut", "QUndoStack", "QActionGroup", "QWidgetAction", "QSystemTrayIcon", "QGraphicsView", "QGraphicsScene", "QMdiArea", "QErrorMessage", "QKeySequenceEdit", "QCompleter", "QLCDNumber", "QDial", "QScrollBar", "QRubberBand", "QToolBox", "QSplashScreen", "QDesktopWidget"]:
    globals()[_name] = type(_name, (_Unavailable,), {})
