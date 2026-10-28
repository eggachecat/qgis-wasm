/**
 * brand.js — the look of this deployment, behind one small interface. Replace this file to re-brand a deployment
 * (a build overlay copies its own brand.js over this one; nothing else changes):
 *
 *   window.qgisBrand = {
 *     name:    'QGIS Desktop',           // product name on the loading page
 *     variant: 'WebAssembly',            // small print under it
 *     accent:  '#589632',                // CSS colour: progress bars, active dots, the workspace button, the agent
 *     spinner() → '<svg …>'              // inline SVG in currentColor that fills its box (loading page 64 px, task strip 18 px)
 *     css:     '…'                       // the spinner's own CSS (keyframes); injected once
 *     facts:   ['<b>…</b> …', …]         // optional: the rotating notes on the loading page (loading.js has defaults)
 *   }
 *
 * The page exposes the accent as the CSS custom properties --brand-accent and --brand-glow on :root, so stylesheets
 * use var(--brand-accent) and never a literal colour. window.qgisSpinner() stays as an alias of brand.spinner().
 */
(function () {
  'use strict';
  const accent = '#589632';
  const brand = {
    name: 'QGIS Desktop',
    variant: 'WebAssembly',
    accent,
    glow: 'rgba(88, 150, 50, .45)',
    // a plain ring: one arc that turns, no logo
    spinner() {
      return '<svg class="brand-ring" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round">'
        + '<circle cx="24" cy="24" r="19" opacity=".18"/>'
        + '<path d="M24 5a19 19 0 0 1 19 19"/>'
        + '</svg>';
    },
    css: '.brand-spinner svg { display: block; height: 100%; width: auto; overflow: visible; }'
      + '.brand-ring { animation: brand-turn .9s linear infinite; transform-origin: 50% 50%; }'
      + '@keyframes brand-turn { to { transform: rotate(360deg); } }'
      + '@media (prefers-reduced-motion: reduce) { .brand-ring { animation: none; } }',
  };
  window.qgisBrand = brand;
  window.qgisSpinner = () => brand.spinner();
  try {
    const root = document.documentElement.style;
    root.setProperty('--brand-accent', brand.accent);
    root.setProperty('--brand-glow', brand.glow);
    const style = document.createElement('style');
    style.id = 'brand-style';
    style.textContent = brand.css;
    document.head.appendChild(style);
  } catch (e) { /* no DOM (tests) */ }
})();
