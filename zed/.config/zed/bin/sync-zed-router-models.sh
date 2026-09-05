#!/usr/bin/env bash
# sync-zed-router-models.sh: keep Zed's ai-model-router model list in sync
# with the live HelloFresh AI Model Router deployment.
#
# Sources:
#   - router /v1/models: which models are actually deployed (ground truth)
#   - pi's models.json: curated metadata (context window, max output, vision)
#   - router /v1/model/info: metadata for models pi does not know yet
#
# Usage: sync-zed-router-models.sh [--dry-run]
set -euo pipefail

DOTFILES="${DOTFILES:-$HOME/dotfiles}"
PI_MODELS="$DOTFILES/pi/.pi/agent/models.json"
ZED_SETTINGS="$DOTFILES/zed/.config/zed/settings.json"
ROUTER_BASE="${AI_MODEL_ROUTER_BASE_URL:-https://ai-model-router-api.eu.foundations.prod.int.hellofresh.io/v1}"
BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Same secret mechanism as pi: env var, loaded from the gitignored dotfiles .env
if [[ -z "${AI_MODEL_ROUTER_API_KEY:-}" && -f "$DOTFILES/.env" ]]; then
  set -a; source "$DOTFILES/.env"; set +a
fi
: "${AI_MODEL_ROUTER_API_KEY:?AI_MODEL_ROUTER_API_KEY not set: add it to ~/dotfiles/.env}"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

echo "Fetching live router deployment from $ROUTER_BASE ..."
curl -sfS -m 15 -H "Authorization: Bearer $AI_MODEL_ROUTER_API_KEY" "$ROUTER_BASE/models" -o "$workdir/models.json"
curl -sfS -m 15 -H "Authorization: Bearer $AI_MODEL_ROUTER_API_KEY" "$ROUTER_BASE/model/info" -o "$workdir/model-info.json"

bun "$BIN_DIR/lib/sync-router-models.ts" "$ZED_SETTINGS" "$PI_MODELS" "$workdir/models.json" "$workdir/model-info.json" "$@"
