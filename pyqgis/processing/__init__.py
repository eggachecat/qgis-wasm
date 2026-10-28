"""processing — `processing.run('native:buffer', {...})` on QGIS' C++ algorithms (results are real project layers)."""
from qgis import _bridge
from qgis.core import QgsMapLayer


def _param_value(v):
    if isinstance(v, QgsMapLayer):
        return v.id()
    if isinstance(v, (list, tuple)):
        return [_param_value(x) for x in v]
    if hasattr(v, "toList") and callable(v.toList):  # QgsRectangle
        return ",".join(str(x) for x in v.toList())
    if hasattr(v, "authid"):
        return v.authid()
    return v


def run(algOrName, parameters, onFinish=None, feedback=None, context=None, is_child_algorithm=False):
    alg_id = algOrName if isinstance(algOrName, str) else algOrName.id()
    params = {k: _param_value(v) for k, v in dict(parameters).items()}
    out = _bridge.call("processing_run", algorithm=alg_id, parameters=params, add_to_project=True)
    results = dict(out.get("results") or {})
    added = {rec["id"]: QgsMapLayer._wrap(rec) for rec in out.get("layers") or []}
    for key, value in list(results.items()):
        if isinstance(value, str) and value in added:
            results[key] = added[value]
    return results


def runAndLoadResults(algOrName, parameters, feedback=None, context=None):
    return run(algOrName, parameters, feedback=feedback, context=context)


def algorithmHelp(alg_id):
    d = _bridge.call("processing_describe", algorithm=alg_id)
    lines = [f"{d.get('id')} ({d.get('name')})", d.get("help", ""), "", "Input parameters:"]
    for p in d.get("parameters", []):
        lines.append(f"  {p['name']}: {p['type']}{' (optional)' if p.get('optional') else ''} — {p.get('description', '')}")
    lines.append("Outputs:")
    for o in d.get("outputs", []):
        lines.append(f"  {o['name']}: {o['type']} — {o.get('description', '')}")
    text = "\n".join(lines)
    print(text)
    return text


def algorithms(filter_text=""):
    return _bridge.call("processing_list", filter=filter_text or None)


class Processing:
    @staticmethod
    def initialize():
        pass


TEMPORARY_OUTPUT = "TEMPORARY_OUTPUT"
