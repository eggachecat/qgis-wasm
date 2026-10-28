"""QgsApplication.processingRegistry() — read-only view of the QGIS Processing algorithms."""
from . import _bridge


class _Algorithm:
    def __init__(self, rec):
        self._r = rec

    def id(self):
        return self._r.get("id", "")

    def name(self):
        return self.id().split(":", 1)[-1]

    def displayName(self):
        return self._r.get("name", "")

    def group(self):
        return self._r.get("group", "")

    def shortHelpString(self):
        return _bridge.call("processing_describe", algorithm=self.id()).get("help", "")

    def parameterDefinitions(self):
        return _bridge.call("processing_describe", algorithm=self.id()).get("parameters", [])

    def __repr__(self):
        return f"<QgsProcessingAlgorithm: {self.id()}>"


def algorithms():
    return [_Algorithm(r) for r in _bridge.call("processing_list")]


def algorithmById(alg_id):
    for r in _bridge.call("processing_list", filter=alg_id):
        if r.get("id") == alg_id:
            return _Algorithm(r)
    return None


def addProvider(provider):
    _bridge.log("processingRegistry().addProvider: Python algorithm providers cannot run in the browser (only QGIS' native C++ algorithms)", "Python", "warning")
    return False
