#!/usr/bin/env bash
# Silence pi's "Host-provided extension packages must be declared in
# peerDependencies with a '*' range" startup warnings and remove the duplicate
# runtime modules they point at.
#
# Why this exists: installed extensions declare pi-provided packages in
# `dependencies` instead of `peerDependencies`:
#   - @tintinweb/pi-subagents 0.19.0: @sinclair/typebox, typebox
#   - pi-hermes-memory 0.9.9: @earendil-works/pi-tui
# Pi supplies those packages to extensions itself (docs/packages.md). Physical
# copies inside ~/.pi/agent/npm/node_modules can bypass pi's extension module
# mapping in compiled ESM and create duplicate classes and registries.
#
# What this script does:
#   1. Moves the offending entries from dependencies to peerDependencies "*"
#      in the installed package.json files (idempotent).
#   2. Deletes the hoisted physical copies so imports resolve to pi's modules.
#
# The npm tree is wiped whenever pi installs, updates, or removes npm: extensions,
# so re-run this script (together with pi-web-access-fix.sh) after any such change.
# To cover a new offender, add it to the `fixes` map and the removal list below.
#
# Remove once fixed upstream:
#   https://github.com/tintinweb/pi-subagents
#   https://github.com/chandra447/pi-hermes-memory
set -euo pipefail

PI_NPM_DIR="$HOME/.pi/agent/npm/node_modules"

# 1. Patch the installed manifests.
node <<'EOF'
const fs = require("fs");
const path = require("path");

const dir = path.join(process.env.HOME, ".pi/agent/npm/node_modules");
// package name -> host-provided modules that belong in peerDependencies
const fixes = {
  "@tintinweb/pi-subagents": ["@sinclair/typebox", "typebox"],
  "pi-hermes-memory": ["@earendil-works/pi-tui"],
};

for (const [pkg, names] of Object.entries(fixes)) {
  const file = path.join(dir, pkg, "package.json");
  if (!fs.existsSync(file)) {
    console.log(`skip, not installed: ${pkg}`);
    continue;
  }
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const deps = manifest.dependencies || {};
  let changed = false;
  for (const name of names) {
    if (deps[name]) {
      delete deps[name];
      (manifest.peerDependencies ||= {})[name] = "*";
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`patched: ${pkg}`);
  } else {
    console.log(`ok, nothing to patch: ${pkg}`);
  }
}
EOF

# 2. Remove the hoisted physical copies so pi's module mapping is used.
# Do not add @earendil-works/pi-coding-agent here: pi-web-access-fix.sh
# deliberately replaces that one with a symlink to the global pi.
for target in typebox @sinclair/typebox @earendil-works/pi-tui; do
  if [[ -e "$PI_NPM_DIR/$target" ]]; then
    rm -rf "$PI_NPM_DIR/$target"
    echo "removed: $PI_NPM_DIR/$target"
  fi
done
# Prune scope dirs left empty by the removals (fails harmlessly if not empty).
rmdir "$PI_NPM_DIR/@sinclair" "$PI_NPM_DIR/@earendil-works" 2>/dev/null || true

echo "done. restart pi to load the patched manifests."
