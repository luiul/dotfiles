#!/usr/bin/env bash
#
# sync-enabled-models.sh
#
# Regenerate the `enabledModels` list in pi's settings.json with the Bedrock
# models this account can ACTUALLY invoke through pi.
#
# Why this is not a simple list:
#   - `pi --list-models` shows pi's full Bedrock catalog (~100 models), but that
#     is not what you can invoke.
#   - Bedrock only lets you invoke models your account is entitled to, exposed as
#     inference profiles (`aws bedrock list-inference-profiles`).
#   - The id conventions differ: pi lists Anthropic Claude WITH a region prefix
#     (eu./global./...), matching the profile ids, but lists Nova/Mistral/etc only
#     under BARE ids that Bedrock rejects. So only the models present in BOTH pi's
#     catalog AND the entitlement list (exact id match) are viable candidates.
#   - Even then, individual models can fail for model-specific reasons (e.g.
#     `global.anthropic.claude-fable-5` -> "data retention mode 'default' is not
#     available for this model"). No id/entitlement heuristic can predict this.
#
# Therefore this script is empirical:
#   candidates = entitled inference-profile ids  ∩  pi catalog ids   (exact match)
#   usable     = candidates that return a response when probed through pi
# Only the probed-usable set is written to enabledModels.
#
# Usage:
#   ./sync-enabled-models.sh            # probe + write settings.json
#   ./sync-enabled-models.sh --dry-run  # probe + print, do not write
#   ./sync-enabled-models.sh --no-probe # skip probing (candidates only; faster,
#                                        # but may include per-model failures)
#
# Env:
#   AWS_PROFILE  (default: sso-bedrock)
#   AWS_REGION   (default: eu-west-1)
#   PI_SETTINGS  (default: the stowed dotfiles settings.json)

set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-sso-bedrock}"
AWS_REGION="${AWS_REGION:-eu-west-1}"
DOTFILES="${DOTFILES:-$HOME/dotfiles}"
PI_SETTINGS="${PI_SETTINGS:-$DOTFILES/pi/.pi/agent/settings.json}"

dry_run=false
probe=true
for arg in "$@"; do
  case "$arg" in
    --dry-run)  dry_run=true ;;
    --no-probe) probe=false ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

command -v aws >/dev/null || { echo "aws CLI not found" >&2; exit 1; }
command -v pi  >/dev/null || { echo "pi not found" >&2; exit 1; }
command -v jq  >/dev/null || { echo "jq not found" >&2; exit 1; }

# Ensure the SSO session is valid before querying/probing.
if ! aws sts get-caller-identity --profile "$AWS_PROFILE" >/dev/null 2>&1; then
  echo "AWS SSO session invalid for '$AWS_PROFILE'. Run: aws sso login --profile $AWS_PROFILE" >&2
  exit 1
fi

# Entitled inference-profile ids (what the account can invoke).
entitled=$(aws bedrock list-inference-profiles \
  --region "$AWS_REGION" --profile "$AWS_PROFILE" \
  --query 'inferenceProfileSummaries[].inferenceProfileId' --output text \
  | tr '\t' '\n' | sort -u)

# pi's supported Bedrock catalog ids (as used by --model).
catalog=$(pi --list-models 2>/dev/null | awk '$1=="amazon-bedrock"{print $2}' | sort -u)

# Candidates = exact id match between the two (see header for why exact).
candidates=$(comm -12 <(echo "$entitled") <(echo "$catalog"))

if [[ -z "$candidates" ]]; then
  echo "No candidate models (entitled ∩ pi catalog is empty). Aborting." >&2
  exit 1
fi
echo "Candidates (entitled ∩ pi catalog): $(echo "$candidates" | wc -l | tr -d ' ')" >&2

# Probe each candidate through pi. A model is usable only if a real prompt
# returns a response with no error/warning. `</dev/null` stops pi -p from
# eating the loop's stdin.
if $probe; then
  usable=""
  while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    if out=$(pi -p "hi" --provider amazon-bedrock --model "$id" </dev/null 2>&1) \
       && ! echo "$out" | grep -qiE 'error|exception|denied|not found|invalid|warning'; then
      echo "  OK    $id" >&2
      usable+="$id"$'\n'
    else
      echo "  FAIL  $id" >&2
    fi
  done < <(echo "$candidates")
  usable=$(printf '%s' "$usable" | sed '/^$/d')
else
  usable="$candidates"
  echo "(--no-probe: using candidates without invocation checks)" >&2
fi

if [[ -z "$usable" ]]; then
  echo "No usable models after probing. Aborting (settings.json unchanged)." >&2
  exit 1
fi

count=$(echo "$usable" | wc -l | tr -d ' ')
echo "Usable models: $count" >&2
echo "$usable" | sed 's/^/  /' >&2

if $dry_run; then
  echo "(--dry-run: settings.json not modified)" >&2
  exit 0
fi

models_json=$(echo "$usable" | jq -R . | jq -s .)
tmp=$(mktemp)
jq --argjson models "$models_json" '.enabledModels = $models' "$PI_SETTINGS" > "$tmp"
mv "$tmp" "$PI_SETTINGS"
echo "Updated enabledModels in $PI_SETTINGS ($count models)" >&2
