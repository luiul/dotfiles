#!/usr/bin/env bash
# Silence pi-web-access's bogus "[pi-web-access] Dynamic tool activation requires
# Pi 0.86.1 or newer" warning, printed at every pi startup.
#
# Why this exists: pi-web-access's supportsDynamicTools() check resolves the
# @earendil-works/pi-coding-agent package.json from its own install dir
# (~/.pi/agent/npm/node_modules). That lookup fails two ways:
#   1. The package is absent (pi is installed globally via Homebrew), so the
#      resolve throws ERR_MODULE_NOT_FOUND.
#   2. Other extensions (pi-diff, pi-subagents, pi-hermes-memory) declare
#      pi-coding-agent as a dependency, so npm hoists a real but STALE copy
#      (e.g. 0.85.1) into the tree; the check reads that old version and still
#      reports "unsupported" (it wants >= 0.86.1).
# Replacing whatever sits at that path with a symlink to the global (current)
# pi makes the version check resolve and pass.
#
# The npm tree is wiped whenever pi installs, updates, or removes npm: extensions,
# so re-run this script after any such change.
#
# Remove once fixed upstream: https://github.com/nicobailon/pi-web-access/issues
set -euo pipefail

PI_NPM_DIR="$HOME/.pi/agent/npm/node_modules"
TARGET="$PI_NPM_DIR/@earendil-works/pi-coding-agent"
PI_PKG="$(npm root -g)/@earendil-works/pi-coding-agent"

if [[ ! -d "$PI_PKG" ]]; then
  echo "error: global pi-coding-agent not found at $PI_PKG" >&2
  exit 1
fi

# npm may have installed a real (stale) directory here. ln -sfn against a real
# directory would nest the symlink inside it, so remove the directory first.
if [[ -d "$TARGET" && ! -L "$TARGET" ]]; then
  rm -rf "$TARGET"
fi

mkdir -p "$PI_NPM_DIR/@earendil-works"
ln -sfn "$PI_PKG" "$TARGET"
echo "linked: $TARGET -> $PI_PKG"
