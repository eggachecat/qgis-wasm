/**
 * markdown.js — Markdown → safe HTML for the panel. marked + DOMPurify are loaded on demand from jsDelivr (same CDN
 * policy as Pyodide); if the CDN is unreachable the renderer degrades to escaped text with line breaks.
 */
const MARKED = 'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js';
const PURIFY = 'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js';

let loading = null;
function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url; s.onload = resolve; s.onerror = () => reject(new Error(`could not load ${url}`));
    document.head.appendChild(s);
  });
}

export function ensureMarkdown() {
  if (window.marked && window.DOMPurify) return Promise.resolve(true);
  if (!loading) loading = Promise.all([window.marked ? null : loadScript(MARKED), window.DOMPurify ? null : loadScript(PURIFY)]).then(() => {
    window.marked.setOptions({ gfm: true, breaks: true });
    return true;
  }).catch((e) => { console.warn(`agent: markdown libraries unavailable (${e.message}); plain text rendering`); return false; });
  return loading;
}

export function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** Synchronous render: rich when the libraries are present, escaped text otherwise. */
export function render(text) {
  if (window.marked && window.DOMPurify) {
    const html = window.marked.parse(text || '');
    return window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'script'] });
  }
  return escapeHtml(text || '').replace(/\n/g, '<br>');
}
