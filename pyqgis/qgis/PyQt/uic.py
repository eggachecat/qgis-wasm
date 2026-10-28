"""qgis.PyQt.uic — Qt Designer forms cannot be instantiated from Python in the browser QGIS."""


def _unsupported(*a, **k):
    raise NotImplementedError(
        "uic.loadUi / loadUiType: Qt Designer dialogs cannot be built from Python in the browser QGIS (the Qt widgets are C++ "
        "inside the WebAssembly module). Replace the dialog with QInputDialog / QMessageBox prompts, several menu entries, "
        "or a web plugin with an HTML panel (docs/03-插件与迁移指南.md)."
    )


loadUi = _unsupported
loadUiType = _unsupported
