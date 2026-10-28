#!/usr/bin/env node
/**
 * Open-source guard: nothing that belongs to a deployment overlay may be in a tree that is about to be published —
 * no secrets, no personal home directories, no internal/ directory, nothing from the overlay's own vocabulary.
 * Run by scripts/export-oss.sh and scripts/export-minimal.sh on the exported worktree and by scripts/export-pages.sh
 * on the staged bundle.
 *
 *   node tests/oss-guard.mjs [dir = .] [--files]     (--files: scan every file of the directory, not only git-tracked ones)
 *
 * The generic patterns below are the same for every deployment (key and token shapes, home directories). A deployment
 * adds its own vocabulary — company, host and product names, user names — in internal/oss-guard.json of the checkout
 * that runs the export ({ "patterns": [{ "re": "...", "flags": "i", "why": "..." }] }); that file is part of the
 * overlay and is never published. OSS_GUARD_PATTERNS=<file> points at another list.
 * Binary files, screenshots and this file are skipped.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const dir = path.resolve(args.find((a) => !a.startsWith("--")) || ".");
const allFiles = args.includes("--files");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = [
  [/\bsk-[A-Za-z0-9_-]{16,}/, "API key"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/X-Auth-Token:\s*[A-Za-z0-9_-]{20,}/, "auth token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\/(home|Users)\/(?!web_user\b)[a-z][a-z0-9_-]*\//, "personal home directory"],
];
const listFile = process.env.OSS_GUARD_PATTERNS || path.join(HERE, "..", "internal", "oss-guard.json");
let listed = 0;
if (fs.existsSync(listFile)) {
  for (const p of JSON.parse(fs.readFileSync(listFile, "utf8")).patterns || []) { FORBIDDEN.push([new RegExp(p.re, p.flags || ""), p.why || "deployment vocabulary"]); listed++; }
}
const SKIP = /\.(png|jpg|jpeg|gif|ico|woff2?|ttf|otf|wasm|data|br|gz|zip|gpkg|qgz|pyc|sqlite|db|pdf)$|(^|\/)(\.git|node_modules|__pycache__|docs\/screenshots)(\/|$)|tests\/oss-guard\.mjs$|LICENSE$/;
let files;
if (allFiles) {
  files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(path.relative(dir, p)); } };
  walk(dir);
} else {
  files = execSync("git ls-files -z", { cwd: dir }).toString("utf8").split("\0").filter(Boolean);
}
const problems = [];
if (fs.existsSync(path.join(dir, "internal"))) problems.push("internal/ exists — the overlay must not be published");
for (const f of files) {
  if (SKIP.test(f)) continue;
  let text;
  try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch (e) { continue; }
  if (/\u0000/.test(text.slice(0, 4096))) continue; // binary
  text.split("\n").forEach((line, i) => { for (const [re, why] of FORBIDDEN) if (re.test(line)) { problems.push(`${f}:${i + 1}: ${why}: ${line.trim().slice(0, 110)}`); break; } });
}
if (problems.length) {
  console.error(`oss-guard: ${problems.length} problem(s) in ${dir}:\n  ` + problems.slice(0, 40).join("\n  ") + (problems.length > 40 ? `\n  … ${problems.length - 40} more` : ""));
  process.exit(1);
}
console.log(`oss-guard: clean (${files.length} files checked in ${path.relative(process.cwd(), dir) || "."}; ${FORBIDDEN.length} patterns${listed ? `, ${listed} from ${path.relative(process.cwd(), listFile)}` : ", no deployment list"})`);
