#!/usr/bin/env bash
# Silence pi-web-access's bogus "[pi-web-access] Dynamic tool activation requires
# Pi 0.86.1 or newer" warning, printed at every pi startup.
#
# Why this exists: pi-web-access's supportsDynamicTools() check resolves the
# @earendil-works/pi-coding-agent package.json from its own install dir
# (~/.pi/agent/npm/node_modules). pi is installed globally via Homebrew, so the
# lookup throws ERR_MODULE_NOT_FOUND and the check wrongly reports
# "unsupported". Linking the global package into the extension tree makes the
# version check resolve and pass.
#
# The npm tree is wiped whenever pi installs, updates, or removes npm: extensions,
# so re-run this script after any such change.
#
# Remove once fixed upstream: https://github.com/nicobailon/pi-web-access/issues
set -euo pipefail

PI_NPM_DIR="$HOME/.pi/agent/npm/node_modules"
PI_PKG="$(npm root -g)/@earendil-works/pi-coding-agent"

if [[ ! -d "$PI_PKG" ]]; then
  echo "error: global pi-coding-agent not found at $PI_PKG" >&2
  exit 1
fi

mkdir -p "$PI_NPM_DIR/@earendil-works"
ln -sfn "$PI_PKG" "$PI_NPM_DIR/@earendil-works/pi-coding-agent"
echo "linked: $PI_NPM_DIR/@earendil-works/pi-coding-agent -> $PI_PKG"
