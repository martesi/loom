#!/usr/bin/env python3
"""Ensure ~/.codex/cc-switch-model-catalog.json exposes none/low/medium/high
reasoning levels for every model, without dropping any extra levels that
cc-switch (or a newer version) may declare. Idempotent; backs up first."""
import json, os, shutil, sys, time

path = os.path.expanduser("~/.codex/cc-switch-model-catalog.json")
desired = ["none", "low", "medium", "high"]

if not os.path.exists(path):
    print(f"not found: {path}")
    sys.exit(1)

shutil.copy2(path, f"{path}.bak-{int(time.time())}")

with open(path) as f:
    data = json.load(f)

changed = 0
for m in data.get("models", []):
    levels = m.get("supported_reasoning_levels") or []
    # preserve descriptions; build ordered union with desired efforts first
    by_effort = {l.get("effort"): l for l in levels if l.get("effort")}
    merged = []
    for e in desired:
        if e in by_effort:
            merged.append(by_effort.pop(e))
        else:
            merged.append({"effort": e, "description": e.capitalize()})
    merged.extend(by_effort.values())  # keep any extras (e.g. max, xhigh)
    if [l.get("effort") for l in levels] != [l.get("effort") for l in merged]:
        m["supported_reasoning_levels"] = merged
        changed += 1

with open(path, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(f"updated {changed} model(s) in {path}")
print("efforts now:", sorted({l.get('effort') for m in data.get('models', []) for l in m.get('supported_reasoning_levels', [])}))
