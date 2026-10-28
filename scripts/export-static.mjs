#!/usr/bin/env node
/**
 * Build a directory ready for a static host that has a per-file limit (Cloudflare Pages: 25 MiB).
 *
 *   node scripts/export-static.mjs [--dir build/qgis/output/bin] [--out build/pages-static]
 *                                  [--r2-base-url https://assets.example.com] [--r2-files qgis.wasm]
 *
 * Same arrangement as scripts/export-pages.sh — qgis.wasm and qgis.data only as .gz, inflated in the browser — plus:
 *   - `_headers`: cross-origin isolation (COOP/COEP) at the edge, so the page does not need the service-worker path;
 *   - `--r2-files`: those members are not shipped here; qgis.bundle.json points at <r2-base-url>/<name>.gz instead
 *     (an R2 public bucket on its own custom domain, for members larger than the host allows).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BIN = path.resolve(ROOT, arg("--dir", "build/qgis/output/bin"));
const OUT = path.resolve(ROOT, arg("--out", "build/pages-static"));
const R2_BASE = (arg("--r2-base-url", "") || "").replace(/\/+$/, "");
const R2_FILES = (arg("--r2-files", "") || "").split(",").map((s) => s.trim()).filter(Boolean);

if (!fs.existsSync(path.join(BIN, "qgis.wasm"))) { console.error(`no build in ${BIN} — run scripts/build-qgis.sh first`); process.exit(1); }
if (R2_FILES.length && !R2_BASE) { console.error("--r2-files needs --r2-base-url"); process.exit(1); }

const SKIP = /^(qgis\.wasm|qgis\.data|qgis\.html|qtlogo\.svg|qgisbuildpath\.txt)$|\.br$|\.gz$|__pycache__/;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const walk = (dir, rel = "") => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (SKIP.test(r)) continue;
    const src = path.join(dir, e.name), dst = path.join(OUT, r);
    if (e.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); walk(path.join(dir, e.name), r); }
    else fs.copyFileSync(src, dst);
  }
};
walk(BIN);

// the big members ship only compressed; anything listed in --r2-files stays on the bucket instead
const GZ_ONLY = ["qgis.wasm", "qgis.data"];   // world_map.gpkg is small enough and is read through the sync lazy loader
const gzOnly = [], remote = [];
for (const name of GZ_ONLY) {
  const gz = path.join(BIN, `${name}.gz`);
  if (!fs.existsSync(gz)) { console.error(`missing ${gz} (scripts/compress-bundle.mjs)`); process.exit(1); }
  gzOnly.push(name);
  if (R2_FILES.includes(name)) { remote.push(name); continue; }
  fs.copyFileSync(gz, path.join(OUT, `${name}.gz`));
}
for (const name of R2_FILES) {
  if (!GZ_ONLY.includes(name)) { console.error(`--r2-files: ${name} is not one of ${GZ_ONLY.join(", ")}`); process.exit(1); }
}

const manifest = JSON.parse(fs.readFileSync(path.join(BIN, "qgis.bundle.json"), "utf8"));
for (const [name, entry] of Object.entries(manifest.files || {})) {
  if (!gzOnly.includes(name)) continue;
  entry.static = "gz";
  delete entry.br;
  if (remote.includes(name)) entry.url = `${R2_BASE}/${name}.gz`;
}
manifest.static = true;
fs.writeFileSync(path.join(OUT, "qgis.bundle.json"), JSON.stringify(manifest, null, 2) + "\n");

// cross-origin isolation at the edge (Cloudflare Pages / Netlify `_headers`); everything revalidates, the bundle is
// not content-addressed and a stale qgis.wasm next to a new qgis.js breaks the module (docs/02 §2.7)
fs.writeFileSync(path.join(OUT, "_headers"), [
  "/*",
  "  Cross-Origin-Opener-Policy: same-origin",
  "  Cross-Origin-Embedder-Policy: credentialless",
  "  Cross-Origin-Resource-Policy: cross-origin",
  "  Cache-Control: public, max-age=0, must-revalidate",
  "",
].join("\n"));

const files = (d, rel = "") => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(d, e.name), path.join(rel, e.name)) : [path.join(rel, e.name)]);
const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
const list = files(OUT).map((f) => [f, fs.statSync(path.join(OUT, f)).size]).sort((a, b) => b[1] - a[1]);
console.log(`static site in ${OUT}: ${list.length} files, ${(size(OUT) / 1048576).toFixed(1)} MB, largest ${list[0][0]} ${(list[0][1] / 1048576).toFixed(1)} MB`);
if (remote.length) console.log(`served from ${R2_BASE}: ${remote.map((n) => n + ".gz").join(", ")}`);
