#!/usr/bin/env python3
"""Summarise compile errors from a ninja build log: for each FAILED unit print the 'error:' lines (+1 line of context)."""
import re, sys
log = sys.argv[1]
text = open(log, errors="replace").read().split("\n")
i = 0; units = []
while i < len(text):
    if text[i].startswith("FAILED:"):
        unit = text[i].split("FAILED:",1)[1].strip(); j = i+1; block=[]
        while j < len(text) and not re.match(r"^\[\d+/\d+\]", text[j]) and not text[j].startswith("FAILED:"):
            block.append(text[j]); j += 1
        units.append((unit, block)); i = j
    else: i += 1
seen=set()
for unit, block in units:
    if unit in seen: continue
    seen.add(unit)
    print("=== " + unit)
    for k, l in enumerate(block):
        if " error: " in l or "error: " in l[:120] and ("undefined" in l or "no member" in l or "not declared" in l or "unknown" in l or "no matching" in l or "cannot" in l or "incomplete" in l or "fatal" in l):
            print("  " + l.strip()[:260])
            if k+1 < len(block) and block[k+1].strip() and not block[k+1].startswith("/"): print("      " + block[k+1].strip()[:200])
print(f"-- {len(seen)} failed units")
