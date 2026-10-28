#!/usr/bin/env node
// Test: every relative markdown link in README/AGENTS/docs resolves to a file (docs exist in both languages).
//   node tests/links.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
for (const f of ["README.md", "README.cn.md", "AGENTS.md"]) if (fs.existsSync(path.join(ROOT, f))) files.push(path.join(ROOT, f));
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "screenshots" && e.name !== "node_modules") walk(p); }
    else if (e.name.endsWith(".md")) files.push(p);
  }
};
walk(path.join(ROOT, "docs"));

let failures = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? " — " + detail : ""}`); if (!ok) failures++; };

const broken = [];
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const p = target.split("#")[0];
    if (!p) continue;
    const resolved = path.resolve(path.dirname(f), decodeURIComponent(p));
    if (!fs.existsSync(resolved)) broken.push(`${path.relative(ROOT, f)} -> ${target}`);
  }
}
check(`${files.length} markdown files, no broken relative links`, broken.length === 0, broken.slice(0, 5).join("; "));

// the two language trees must stay paired: every docs/NN-*.md has docs/en/NN-*.md and vice versa
const cn = fs.readdirSync(path.join(ROOT, "docs")).filter((f) => /^\d\d-.*\.md$/.test(f)).sort();
const en = fs.existsSync(path.join(ROOT, "docs/en")) ? fs.readdirSync(path.join(ROOT, "docs/en")).filter((f) => /^\d\d-.*\.md$/.test(f)).sort() : [];
check(`Chinese docs: ${cn.length}`, cn.length === 6);
check(`English docs: ${en.length} (same numbering as the Chinese ones)`, en.length === cn.length && cn.every((f, i) => f.slice(0, 2) === en[i].slice(0, 2)));

// each Chinese document links to its English sibling and each English one back
for (const f of cn) {
  const head = fs.readFileSync(path.join(ROOT, "docs", f), "utf8").split("\n").slice(0, 5).join("\n");
  check(`${f} links to its English sibling`, /\]\(en\/\d\d-[^)]+\.md\)/.test(head));
}
for (const f of en) {
  const head = fs.readFileSync(path.join(ROOT, "docs/en", f), "utf8").split("\n").slice(0, 5).join("\n");
  check(`en/${f} links back to its Chinese original`, /\]\(\.\.\/\d\d-[^)]+\.md\)/.test(head));
}

console.log(failures ? `FAILED (${failures})` : "OK");
process.exit(failures ? 1 : 0);
