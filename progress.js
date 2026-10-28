/**
 * progress.js — the page's task bus. Every long operation of the web layer reports itself here — sharing a snapshot,
 * opening one, querying a data source, downloading a file, applying a link — and the user interfaces only listen:
 * the workspace (a strip under its header while open, a pill beside the button and a ring on it while closed), the
 * loading page while it is still up (a ?share= link keeps it as a veil until the project is in) and the Debug view
 * (every task with its duration). QGIS knows nothing about it; nothing here touches QGIS.
 *
 *   const t = qgisProgress.begin('Sharing a snapshot', { detail: 'Collecting the layers' })
 *   t.set('Uploading x.geojson')                       // the detail line
 *   t.update({ done, total, unit: 'bytes', detail })   // determinate (bytes get a rate); done/total null → indeterminate
 *   t.finish() / t.fail(err)
 *   qgisProgress.run(label, async (t) => …)            // begin + done / fail around a function, returns its result
 *   qgisProgress.on((e) => …) → off                    // e: { type: 'begin' | 'update' | 'end', task }
 *   qgisProgress.active() / .current()                 // running tasks, oldest first / the most recent one
 *   qgisProgress.fmt.bytes(n) / .rate(bytesPerSecond)
 */
(function () {
  'use strict';

  const listeners = new Set();
  const tasks = new Map();
  let seq = 0;
  const now = () => performance.now();
  const emit = (type, task) => { for (const fn of listeners) { try { fn({ type, task }); } catch (e) { console.error('progress listener failed', e); } } };

  const fmt = {
    bytes: (n) => (n == null ? '' : n >= 1e7 ? `${(n / 1e6).toFixed(0)} MB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} KB` : `${Math.round(n)} B`),
    rate: (bps) => (bps == null ? '' : bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${(bps / 1e3).toFixed(0)} KB/s`),
    duration: (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`),
  };

  function begin(label, { detail = '', done = null, total = null, unit = null } = {}) {
    const task = {
      id: ++seq, label: String(label || 'Working'), detail: String(detail || ''), done, total, unit, rate: null,
      startedAt: now(), endedAt: null, error: null,
      get active() { return this.endedAt == null; },
      get elapsed() { return (this.endedAt ?? now()) - this.startedAt; },
      /** the fraction done, or null when the task is indeterminate */
      get fraction() { return this.total > 0 && this.done != null ? Math.max(0, Math.min(1, this.done / this.total)) : null; },
      set(detail) { return this.update({ detail }); },
      update(patch = {}) {
        if (this.endedAt != null) return this;
        if (patch.label != null) this.label = String(patch.label);
        if (patch.detail != null) this.detail = String(patch.detail);
        if ('done' in patch) this.done = patch.done;
        if ('total' in patch) this.total = patch.total;
        if ('unit' in patch) this.unit = patch.unit;
        if (this.unit === 'bytes' && this.done > 0) { const s = this.elapsed / 1000; this.rate = s > 0.3 ? this.done / s : null; }
        emit('update', this);
        return this;
      },
      finish(detail) { return end(this, null, detail); },
      fail(err) { return end(this, err || new Error('failed')); },
    };
    tasks.set(task.id, task);
    emit('begin', task);
    return task;
  }
  function end(task, err, detail) {
    if (task.endedAt != null) return task;
    task.endedAt = now();
    task.error = err ? (err.message || String(err)) : null;
    if (!err && task.total > 0 && task.done != null) task.done = task.total;
    if (detail != null) task.detail = String(detail);
    tasks.delete(task.id);
    emit('end', task);
    return task;
  }
  async function run(label, fn, opts) {
    const task = begin(label, opts);
    try { const r = await fn(task); task.finish(); return r; } catch (e) { task.fail(e); throw e; }
  }
  const active = () => [...tasks.values()];
  const current = () => { let last = null; for (const t of tasks.values()) last = t; return last; };
  /** The text a UI shows for a task: detail, then "x of y" (bytes with a rate; other units as counts) */
  function describe(task) {
    if (!task) return '';
    const parts = [];
    if (task.detail) parts.push(task.detail);
    if (task.total > 0 && task.done != null) {
      if (task.unit === 'bytes') parts.push(`${fmt.bytes(task.done)} of ${fmt.bytes(task.total)}${task.rate ? ` · ${fmt.rate(task.rate)}` : ''}`);
      else parts.push(`${task.done} of ${task.total}${task.unit ? ` ${task.unit}` : ''}`);
    }
    return parts.join(' · ');
  }

  window.qgisProgress = { begin, run, active, current, describe, fmt, on(fn) { listeners.add(fn); return () => listeners.delete(fn); }, get count() { return tasks.size; } };
})();
