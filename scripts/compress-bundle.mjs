#!/usr/bin/env node
/**
 * Pre-compress the big static files of the bundle into .br and .gz sidecars next to the originals:
 * qgis.wasm (134 MB → ~31 MB brotli), qgis.data (19 MB → ~3 MB), qgis.js and the lazily fetched files listed in
 * qgis.lazy.json (world_map.gpkg 13 MB → ~4.5 MB). scripts/serve.mjs sends the sidecar when the
 * browser accepts the encoding (nginx: `brotli_static on; gzip_static on;`), so a first load moves ~34 MB instead
 * of ~166 MB. Sidecars that are already newer than their file are skipped; build-qgis.sh runs this after every build.
 *
 *   node scripts/compress-bundle.mjs [--dir build/qgis/output/bin] [--quality 9] [--only qgis.data,qgis.js] [--no-gzip] [--force]
 *
 * Also writes qgis.bundle.json (raw and compressed size of every bundle file): the loading page counts the bytes of
 * qgis.wasm / qgis.data / qgis.js against it and shows real megabytes instead of a bare bar.
 *
 * Brotli quality 9 is the sweet spot for a 134 MB file (≈18 s, 31 MB); 11 takes minutes for ~2 MB less.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const DIR = path.resolve(here, "..", arg("--dir", "build/qgis/output/bin"));
const QUALITY = Number(arg("--quality", 9));
const FILES = arg("--only", "qgis.wasm,qgis.data,qgis.js").split(",").map((s) => s.trim()).filter(Boolean);
// plus the files the build serves next to qgis.js instead of packing into qgis.data (qgis.lazy.json, cmake/QgisWasmApp.cmake)
if (!args.includes("--only")) {
  try { for (const f of JSON.parse(fs.readFileSync(path.join(DIR, "qgis.lazy.json"), "utf8")).files || []) if (f.path && !FILES.includes(f.path)) FILES.push(f.path); } catch { /* no manifest */ }
}
const GZIP = !args.includes("--no-gzip");
const FORCE = args.includes("--force");
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

async function compress(file, suffix, make) {
  const out = file + suffix;
  const src = fs.statSync(file);
  if (!FORCE && fs.existsSync(out) && fs.statSync(out).mtimeMs >= src.mtimeMs) { console.log(`  ${path.basename(out)}: up to date (${mb(fs.statSync(out).size)})`); return; }
  const tmp = `${out}.tmp-${process.pid}`;
  const t0 = Date.now();
  await pipeline(fs.createReadStream(file), make(src.size), fs.createWriteStream(tmp));
  fs.renameSync(tmp, out); // atomic: serve.mjs never sees a half written sidecar
  console.log(`  ${path.basename(out)}: ${mb(src.size)} → ${mb(fs.statSync(out).size)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

console.log(`compressing in ${DIR} (brotli q${QUALITY}${GZIP ? ", gzip" : ""})`);
for (const name of FILES) {
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) { console.log(`  ${name}: missing, skipped`); continue; }
  await compress(file, ".br", (size) => zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: QUALITY, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 } }));
  if (GZIP) await compress(file, ".gz", () => zlib.createGzip({ level: 6 }));
}

// qgis.bundle.json: raw and over-the-wire sizes for the loading page (the shell fetches it together with the preset)
let lazyNames = [];
try { lazyNames = (JSON.parse(fs.readFileSync(path.join(DIR, "qgis.lazy.json"), "utf8")).files || []).map((f) => f.path); } catch { /* no manifest */ }
const manifest = { built: new Date().toISOString(), files: {} };
for (const name of [...new Set(["qgis.wasm", "qgis.data", "qgis.js", ...FILES, ...lazyNames])]) {
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) continue;
  const entry = { size: fs.statSync(file).size };
  if (lazyNames.includes(name)) entry.lazy = true;
  for (const [key, suffix] of [["br", ".br"], ["gz", ".gz"]]) if (fs.existsSync(file + suffix)) entry[key] = fs.statSync(file + suffix).size;
  manifest.files[name] = entry;
}
fs.writeFileSync(path.join(DIR, "qgis.bundle.json"), JSON.stringify(manifest, null, 1) + "\n");
console.log(`  qgis.bundle.json: ${Object.keys(manifest.files).length} files, ${mb(Object.values(manifest.files).filter((f) => !f.lazy).reduce((a, f) => a + f.size, 0))} raw / ${mb(Object.values(manifest.files).filter((f) => !f.lazy).reduce((a, f) => a + (f.br || f.size), 0))} brotli at first load`);
