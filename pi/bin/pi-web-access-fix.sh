#!/usr/bin/env bash
# Silence pi-web-access's bogus "[pi-web-access] Dynamic tool activation requires
# Pi 0.86.1 or newer" warning, printed at every pi startup.
#
# Why this exists: pi-web-access's supportsDynamicTools() check resolves the
# @earendil-works/pi-coding-agent package.json from its own install dir
# (~/.pi/agent/npm/node_modules). That lookup fails two ways:
#   1. The package is absent there, so the resolve throws ERR_MODULE_NOT_FOUND.
#      (It is NOT in the extension tree by default: pi is either a managed
#      install at ~/.pi/agent/install/releases/<version>/ or, on the legacy
#      setup, an npm global install.)
#   2. Other extensions (pi-diff, pi-subagents, pi-hermes-memory) declare
#      pi-coding-agent as a dependency, so npm hoists a real but STALE copy
#      (e.g. 0.85.1) into the tree; the check reads that old version and still
#      reports "unsupported" (it wants >= 0.86.1).
# Replacing whatever sits at that path with a symlink to the current pi
# installation makes the version check resolve and pass.
#
# The npm tree is wiped whenever pi installs, updates, or removes npm: extensions,
# so re-run this script after any such change. After `pi update`, re-run it so the
# symlink follows the new managed release version.
#
# Remove once fixed upstream: https://github.com/nicobailon/pi-web-access/issues
set -euo pipefail

PI_NPM_DIR="$HOME/.pi/agent/npm/node_modules"
TARGET="$PI_NPM_DIR/@earendil-works/pi-coding-agent"

# Resolve the current pi installation: prefer the managed install
# (~/.pi/agent/install/releases/<version>/, written by `pi install`/`pi update`),
# fall back to the legacy npm global install.
PI_VERSION_FILE="$HOME/.pi/agent/install/current-version"
if [[ -r "$PI_VERSION_FILE" ]]; then
  read -r pi_version < "$PI_VERSION_FILE"
  PI_PKG="$HOME/.pi/agent/install/releases/$pi_version/node_modules/@earendil-works/pi-coding-agent"
elif [[ -d "$(npm root -g 2>/dev/null)/@earendil-works/pi-coding-agent" ]]; then
  PI_PKG="$(npm root -g)/@earendil-works/pi-coding-agent"
fi

if [[ -z "${PI_PKG:-}" || ! -d "$PI_PKG" ]]; then
  echo "error: no pi-coding-agent installation found (managed install or npm global)" >&2
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
