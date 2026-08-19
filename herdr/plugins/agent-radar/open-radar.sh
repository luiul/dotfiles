#!/bin/bash
# Action entrypoint: opens the Agent Radar pane. Bound in herdr-plugin.toml
# as the "open-radar" action, and to a keybinding in config.toml.
set -euo pipefail

HERDR_BIN="${HERDR_BIN_PATH:-herdr}"
"$HERDR_BIN" plugin pane open --plugin luiul.agent-radar --entrypoint radar --placement split --direction right --focus
