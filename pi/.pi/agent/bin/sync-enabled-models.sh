#!/usr/bin/env bash
#
# sync-enabled-models.sh
#
# Scan EVERY AWS region this account has Bedrock entitlements in, find every
# Bedrock model actually invocable through pi (independent of region), and:
#   1. validate + write pi/.pi/agent/settings.json .enabledModels, which is a
#      hand-curated list of minimatch patterns (CURATED_PATTERNS below), NOT
#      the full probe-verified list. Patterns keep the /model and Ctrl+P
#      picker small (only the model families actually in use, in the regions
#      they are used in) while absorbing new model versions automatically.
#      The script reports each pattern's live match count (zero = dead
#      pattern, probably a retired or renamed model), lists usable models no
#      pattern covers (candidates for new patterns), and warns about
#      hand-added entries the write would drop. This is safe because of (2)
#      below: an extension keeps AWS_REGION in sync with whichever model is
#      actually selected, so a non-default-region entry doesn't 400 when
#      picked.
#   2. write pi/.pi/agent/bedrock-models.json, a full { modelId: region } map
#      of EVERY usable model across ALL scanned regions. Two consumers read
#      it: the pi extension pi/.pi/agent/extensions/bedrock-region-sync.ts
#      (fires on model_select/session_start, sets process.env.AWS_REGION to
#      match whatever model is active inside a running pi session — this is
#      what makes (1) safe) and the zsh functions pi-use / pi-region /
#      pi-models (funcs_pi_bedrock.zsh, for switching model/region from the
#      shell before pi even starts, e.g. one-off `pi-use <id> -p "..."` calls).
#
# Why this is not a simple list:
#   - `pi --list-models` shows pi's full Bedrock catalog (~100 models), but that
#     is not what you can invoke.
#   - Bedrock models fall into two invocation modes (see each model's
#     `inferenceTypesSupported` from `list-foundation-models`):
#       - INFERENCE_PROFILE-only (e.g. all current Claude): must be invoked via a
#         cross-region inference profile id, exposed by
#         `aws bedrock list-inference-profiles`. The id prefix (eu./us./au./jp./
#         global.) tells you which region group it belongs to; global. works
#         from any region, the others only from their own region group.
#       - ON_DEMAND (e.g. openai.gpt-oss-*, moonshotai.kimi-*, mistral.*, qwen.*,
#         minimax.*, google.gemma-*, nvidia.nemotron-*, zai.*): invoked directly
#         by a bare model id, never appears in list-inference-profiles at all,
#         and is only listed (with ON_DEMAND in inferenceTypesSupported) by
#         list-foundation-models IN THE SPECIFIC REGION(S) it's deployed to —
#         e.g. moonshotai.kimi-k2.5 is entirely absent from eu-west-1's catalog
#         but present in us-east-1's.
#   - The id conventions differ: pi lists Anthropic Claude WITH a region prefix
#     (eu./us./au./jp./global.), matching the profile ids, but lists most
#     ON_DEMAND models only under BARE ids (no prefix at all). So matching is
#     exact-id, per region, against whichever source (profiles or on-demand)
#     that region actually returns.
#   - Even matching ids can fail for model-specific reasons (e.g.
#     `global.anthropic.claude-fable-5` -> "data retention mode 'default' is not
#     available for this model"). No id/entitlement heuristic can predict this;
#     only a live probe through pi does.
#   - pi has no per-model region config in settings.json — it always invokes in
#     whatever AWS_REGION is exported (or the sso-bedrock profile's configured
#     region, eu-west-1, if unset). A model only entitled/on-demand in a
#     non-default region will 400 unless AWS_REGION is switched first. That's
#     exactly what bedrock-models.json + the pi-use/pi-region zsh functions
#     automate: look up the right region per model and export it for you.
#
# Therefore this script is empirical, per region:
#   bedrock_ids(region) = entitled inference-profile ids(region) ∪ ON_DEMAND foundation-model ids(region)
#   candidates(region)  = bedrock_ids(region) ∩ pi catalog ids                    (exact match)
# candidates across all regions are deduped (preferring the default region, then
# a model's explicit prefix's home region, then first-seen) before probing, so
# each model id is probed exactly once, in the one region it will actually be
# invoked from.
#   usable = candidates that return a response when probed through pi (AWS_REGION
#            set to that candidate's region), run with bounded concurrency.
#
# Usage:
#   ./sync-enabled-models.sh            # probe + write settings.json + bedrock-models.json
#   ./sync-enabled-models.sh --dry-run  # probe + print, do not write
#   ./sync-enabled-models.sh --no-probe # skip probing (candidates only; faster,
#                                        # but may include per-model/per-region failures)
#
# Env:
#   AWS_PROFILE        (default: sso-bedrock)
#   AWS_REGION         (default: eu-west-1) — the DEFAULT region pi invokes in
#                       with no override; its usable subset becomes enabledModels.
#   BEDROCK_REGIONS     space-separated extra regions to scan for entitlements
#                       beyond AWS_REGION (default: "us-east-1 ap-northeast-1
#                       ap-southeast-2" — covers the us./jp./au. inference-profile
#                       prefixes seen in pi's catalog; global. and eu. are already
#                       covered by AWS_REGION when it's an EU region).
#   PROBE_TIMEOUT       per-model probe timeout in seconds (default: 45)
#   PROBE_CONCURRENCY   parallel probes (default: 3 -- kept low deliberately;
#                       a prior run at concurrency 6 fanned out across 4
#                       regions caused a burst of concurrent Bedrock/SSO
#                       credential-resolution failures that cascaded into
#                       several stray `aws sso login` processes. See the
#                       circuit breaker below.)
#   PROBE_FAIL_CIRCUIT  consecutive-failure threshold that aborts the rest of
#                       the probe batch instead of continuing to hammer AWS
#                       (default: 6). Sized to PROBE_CONCURRENCY so one bad
#                       batch trips it, not one bad model.
#   PI_SETTINGS         (default: the stowed dotfiles settings.json)
#   BEDROCK_MODELS_JSON (default: the stowed dotfiles bedrock-models.json)
#
# AWS authentication contract (read this before touching auth logic):
#   - This script NEVER invokes `aws sso login` itself, under any
#     circumstance. It only ever checks validity (`aws sts
#     get-caller-identity`, cheap and side-effect-free) and, if invalid,
#     prints the exact command for the HUMAN to run and exits. Automating
#     that call is exactly what caused the runaway-login incident above.
#   - The validity check runs at most ONCE per script invocation (not once
#     per region, not once per probe) -- "only authenticate if necessary"
#     means: check once, trust the result for the rest of the run, and let
#     the circuit breaker (not repeated re-auth) handle the run going bad
#     mid-flight.

set -uo pipefail

AWS_PROFILE="${AWS_PROFILE:-sso-bedrock}"
DEFAULT_REGION="${AWS_REGION:-eu-west-1}"
EXTRA_REGIONS="${BEDROCK_REGIONS:-us-east-1 ap-northeast-1 ap-southeast-2}"
DOTFILES="${DOTFILES:-$HOME/dotfiles}"
PI_SETTINGS="${PI_SETTINGS:-$DOTFILES/pi/.pi/agent/settings.json}"
BEDROCK_MODELS_JSON="${BEDROCK_MODELS_JSON:-$DOTFILES/pi/.pi/agent/bedrock-models.json}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-45}"
PROBE_CONCURRENCY="${PROBE_CONCURRENCY:-3}"
PROBE_FAIL_CIRCUIT="${PROBE_FAIL_CIRCUIT:-6}"
# enabledModels is this hand-curated list of patterns (minimatch against
# provider/modelId or bare modelId; a ":<level>" suffix pins a thinking
# level). The probe below VALIDATES these patterns against what is currently
# invocable; it never adds or removes patterns itself. Edit this list to
# change what /model and Ctrl+P offer.
CURATED_PATTERNS=(
  'moonshotai/Kimi-K3:high'
  'gpt-5.6-luna:max'
  'global.openai.gpt-5.6-luna:max'
  'moonshotai/Kimi-K3*'
  'claude-sonnet-5*'
  'claude-opus-5*'
  'claude-opus-4-8*'
  'claude-haiku-4-5*'
  'gpt-5.6-luna*'
  'zai-org/GLM-5*'
  'deepseek-ai/DeepSeek-V4*'
  'eu.anthropic.claude-sonnet-5*'
  'eu.anthropic.claude-sonnet-4-6*'
  'eu.anthropic.claude-opus-5*'
  'eu.anthropic.claude-opus-4-8*'
  'eu.anthropic.claude-haiku-4-5*'
  'global.anthropic.claude-sonnet-5*'
  'global.anthropic.claude-sonnet-4-6*'
  'global.anthropic.claude-opus-5*'
  'global.anthropic.claude-opus-4-8*'
  'global.anthropic.claude-haiku-4-5*'
  'us.anthropic.claude-sonnet-5*'
  'us.anthropic.claude-sonnet-4-6*'
  'us.anthropic.claude-opus-5*'
  'us.anthropic.claude-opus-4-8*'
  'us.anthropic.claude-haiku-4-5*'
  'global.openai.gpt-5.6-luna*'
  'us.openai.gpt-5.6-luna*'
)
# Some globally named inference profiles are only enabled in a particular
# region for this account. Keep these overrides explicit and exact rather
# than silently selecting the default region after a failed probe.
MODEL_REGION_OVERRIDES="${MODEL_REGION_OVERRIDES:-global.openai.gpt-5.6-sol=us-east-1}"
export AWS_PROFILE PROBE_FAIL_CIRCUIT

# All regions to scan, default first (its usable subset becomes enabledModels).
read -r -a REGIONS <<< "$DEFAULT_REGION $EXTRA_REGIONS"

dry_run=false
probe=true
for arg in "$@"; do
  case "$arg" in
    --dry-run)  dry_run=true ;;
    --no-probe) probe=false ;;
    --help|-h)
      sed -n '2,/^set -uo pipefail/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//; s/^#$//'
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

case "$PROBE_TIMEOUT" in
  ''|*[!0-9]*) echo "PROBE_TIMEOUT must be a positive integer (got: $PROBE_TIMEOUT)" >&2; exit 2 ;;
  0) echo "PROBE_TIMEOUT must be a positive integer" >&2; exit 2 ;;
esac
case "$PROBE_CONCURRENCY" in
  ''|*[!0-9]*) echo "PROBE_CONCURRENCY must be a positive integer (got: $PROBE_CONCURRENCY)" >&2; exit 2 ;;
  0) echo "PROBE_CONCURRENCY must be a positive integer" >&2; exit 2 ;;
esac
case "$PROBE_FAIL_CIRCUIT" in
  ''|*[!0-9]*) echo "PROBE_FAIL_CIRCUIT must be a positive integer (got: $PROBE_FAIL_CIRCUIT)" >&2; exit 2 ;;
  0) echo "PROBE_FAIL_CIRCUIT must be a positive integer" >&2; exit 2 ;;
esac

command -v aws >/dev/null || { echo "aws CLI not found" >&2; exit 1; }
command -v pi  >/dev/null || { echo "pi not found" >&2; exit 1; }
command -v jq  >/dev/null || { echo "jq not found" >&2; exit 1; }

# Ensure the SSO session is valid before querying/probing -- exactly ONE
# check, ever, for this whole run. On failure we print the fix and exit; we
# do NOT run `aws sso login` ourselves (see contract in the header comment).
if ! aws sts get-caller-identity --profile "$AWS_PROFILE" >/dev/null 2>&1; then
  echo "AWS SSO session invalid for '$AWS_PROFILE'. Run this yourself: aws sso login --profile $AWS_PROFILE" >&2
  exit 1
fi

# pi's supported Bedrock catalog ids (as used by --model).
catalog=$(pi --list-models 2>/dev/null | awk '$1=="amazon-bedrock"{print $2}' | sort -u)

workdir=$(mktemp -d)
export workdir
trap 'rm -rf "$workdir"' EXIT

echo "Scanning regions: ${REGIONS[*]} (default: $DEFAULT_REGION)" >&2

# Per region: bedrock_ids(region) ∩ pi catalog, written to $workdir/cand_<region>
for region in "${REGIONS[@]}"; do
  entitled=$(aws bedrock list-inference-profiles \
    --region "$region" --profile "$AWS_PROFILE" \
    --query 'inferenceProfileSummaries[].inferenceProfileId' --output text 2>/dev/null \
    | tr '\t' '\n' | sort -u)

  ondemand=$(aws bedrock list-foundation-models \
    --region "$region" --profile "$AWS_PROFILE" --output json 2>/dev/null \
    | jq -r '.modelSummaries[] | select(.inferenceTypesSupported // [] | index("ON_DEMAND")) | .modelId' \
    | sort -u)

  bedrock_ids=$(printf '%s\n%s\n' "$entitled" "$ondemand" | sed '/^$/d' | sort -u)
  comm -12 <(echo "$bedrock_ids") <(echo "$catalog") > "$workdir/cand_$region"
  n=$(wc -l < "$workdir/cand_$region" | tr -d ' ')
  echo "  $region: $n candidate id(s)" >&2
done

# Dedupe across regions: each candidate id is assigned to exactly ONE region to
# probe from -- preferring $DEFAULT_REGION, then (for prefixed ids) its home
# region by prefix, then whichever scanned region listed it first. Plain
# case/if (not associative arrays: this account's /bin/bash is 3.2, which
# predates `declare -A`).
region_for_id() {
  local id="$1" pair override_id override_region
  for pair in $MODEL_REGION_OVERRIDES; do
    override_id="${pair%%=*}"
    override_region="${pair#*=}"
    if [[ "$id" == "$override_id" ]]; then
      echo "$override_region"
      return
    fi
  done
  case "$id" in
    eu.*)         echo "eu-west-1" ;;
    global.*)     echo "$DEFAULT_REGION" ;;
    us.*)         echo "us-east-1" ;;
    jp.*)         echo "ap-northeast-1" ;;
    au.*)         echo "ap-southeast-2" ;;
    *)             echo "" ;;
  esac
}
: > "$workdir/candidates.tsv"
seen_ids=""
for region in "${REGIONS[@]}"; do
  while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    case $'\n'"$seen_ids"$'\n' in *$'\n'"$id"$'\n'*) continue ;; esac
    assigned=""
    if [[ -n "$MODEL_REGION_OVERRIDES" ]]; then
      assigned=$(region_for_id "$id")
    fi
    if [[ -z "$assigned" ]] && grep -qxF "$id" "$workdir/cand_$DEFAULT_REGION" 2>/dev/null; then
      assigned="$DEFAULT_REGION"
    fi
    if [[ -z "$assigned" ]]; then
      assigned=$(region_for_id "$id")
      [[ -z "$assigned" ]] && assigned="$region"
    fi
    printf '%s %s\n' "$id" "$assigned" >> "$workdir/candidates.tsv"
    seen_ids+="$id"$'\n'
  done < "$workdir/cand_$region"
done

total=$(wc -l < "$workdir/candidates.tsv" | tr -d ' ')
if [[ "$total" -eq 0 ]]; then
  echo "No candidate models found in any scanned region. Aborting." >&2
  exit 1
fi
echo "Total unique candidates across all regions: $total" >&2

# Probe each candidate through pi in its assigned region, with bounded
# concurrency (xargs -P) and a per-probe timeout. There's no timeout/gtimeout
# binary on stock macOS, so the timeout is hand-rolled: background pi, race it
# against a sleep-then-kill watcher, reap whichever finishes first. Cleanup
# calls are suffixed `|| true` — under `set -e` a kill/wait on an
# already-exited watcher returns non-zero and would otherwise silently abort
# the whole probe.
#
# Circuit breaker: a shared counter file (workdir/fail_streak) tracks how many
# CONSECUTIVE SYSTEMIC probes have failed (timeouts, auth, network,
# throttling). If it reaches PROBE_FAIL_CIRCUIT, a trip file is written and
# every probe still queued in xargs short-circuits to SKIP without ever
# invoking `pi`/`aws` again. This is what should have stopped the run that
# produced the runaway `aws sso login` processes: a systemic break shows up
# as a run of failures well before all candidates would otherwise be
# hammered. Per-model failures (marketplace not subscribed, model doesn't
# support streaming tool use, ...) are neutral: they neither advance nor
# reset the streak, so a cluster of account-unavailable catalog ids cannot
# false-trip the breaker. Any OK proves service health and resets the streak.
: > "$workdir/fail_streak"
probe_one() {
  local id="$1" region="$2" timeout="$3"

  if [[ -f "$workdir/circuit_tripped" ]]; then
    echo "SKIP	$id	$region	(circuit breaker tripped -- see earlier error)"
    return
  fi

  local tmpout status
  tmpout=$(mktemp)
  ( set +e
    AWS_PROFILE="$AWS_PROFILE" AWS_REGION="$region" pi -p "hi" --provider amazon-bedrock --model "$id" --no-session --no-extensions </dev/null >"$tmpout" 2>&1 &
    probe_pid=$!
    ( sleep "$timeout"; kill -9 "$probe_pid" 2>/dev/null ) &
    watcher_pid=$!
    wait "$probe_pid" 2>/dev/null
    status=$?
    kill "$watcher_pid" 2>/dev/null || true
    wait "$watcher_pid" 2>/dev/null || true
    exit $status
  )
  status=$?
  local out result systemic reason
  systemic=0
  out=$(cat "$tmpout" 2>/dev/null); rm -f "$tmpout"
  if [[ $status -eq 137 ]]; then
    result="FAIL	$id	$region	(timed out after ${timeout}s)"
    systemic=1
  elif [[ $status -eq 0 ]] \
     && ! echo "$out" | grep -qiE 'error|exception|denied|not found|invalid|warning'; then
    result="OK	$id	$region"
  else
    # Distinguish systemic failures (auth/network/throttle -- the circuit
    # breaker's job) from per-model ones (marketplace not subscribed, no
    # streaming tool use, ...). pi exits 0 even when the model call fails,
    # so classification is by output text. A cluster of newly catalogued but
    # account-unavailable models (sorted ids cluster alphabetically) must NOT
    # trip the breaker -- that was the 2026-09-14 false trip.
    reason=$(echo "$out" | grep -iE 'error|exception|denied|not found|invalid' | head -1 | cut -c1-120)
    result="FAIL	$id	$region	($reason)"
    if echo "$out" | grep -qiE 'sso|expired.?token|credential|throttl|econnrefused|enotfound|etimedout|socket hang up|could not connect|unable to locate'; then
      systemic=1
    fi
  fi

  # Non-atomic streak update -- fine for a heuristic breaker at low
  # concurrency; worst case it trips a probe or two late/early. Only systemic
  # failures advance the streak; per-model failures neither advance nor reset
  # it, so a run of unavailable models neither trips the breaker nor hides a
  # real cascade in progress. Any OK proves service health and resets.
  if [[ "$result" == OK* ]]; then
    : > "$workdir/fail_streak"
  elif [[ $systemic -eq 1 ]]; then
    printf 'x' >> "$workdir/fail_streak"
    streak_len=$(wc -c < "$workdir/fail_streak" | tr -d ' ')
    if [[ "$streak_len" -ge "$PROBE_FAIL_CIRCUIT" && ! -f "$workdir/circuit_tripped" ]]; then
      touch "$workdir/circuit_tripped"
      echo "CIRCUIT-BREAKER	-	-	($streak_len consecutive failures -- aborting remaining probes. Check AWS auth/network by hand; this script will NOT retry or re-authenticate.)" >&2
    fi
  fi
  echo "$result"
}
export -f probe_one

if $probe; then
  echo "Probing $total candidate(s), up to $PROBE_CONCURRENCY at a time, ${PROBE_TIMEOUT}s timeout each (circuit breaker: $PROBE_FAIL_CIRCUIT consecutive fails)..." >&2
  results_file="$workdir/results.tsv"
  xargs -P "$PROBE_CONCURRENCY" -I{} bash -c '
    read -r id region <<< "{}"
    probe_one "$id" "$region" "'"$PROBE_TIMEOUT"'"
  ' < "$workdir/candidates.tsv" | tee "$results_file" | sed 's/^/  /' >&2
  if [[ -f "$workdir/circuit_tripped" ]]; then
    echo "Circuit breaker tripped: too many consecutive probe failures. Aborting without writing settings.json / bedrock-models.json." >&2
    echo "This is NOT auto-retried and did NOT run 'aws sso login'. Re-run manually once you've confirmed AWS/network health." >&2
    exit 1
  fi
  usable_tsv=$(awk -F'\t' '$1=="OK"{print $2"\t"$3}' "$results_file")
else
  usable_tsv=$(awk '{print $1"\t"$2}' "$workdir/candidates.tsv")
  echo "(--no-probe: using candidates without invocation checks)" >&2
fi

if [[ -z "$usable_tsv" ]]; then
  echo "No usable models after probing. Aborting (files unchanged)." >&2
  exit 1
fi

count=$(echo "$usable_tsv" | wc -l | tr -d ' ')
echo "Usable models across all regions: $count" >&2
echo "$usable_tsv" | awk -F'\t' '{print "  "$1" ("$2")"}' | sort >&2

default_ids=$(echo "$usable_tsv" | awk -F'\t' -v r="$DEFAULT_REGION" '$2==r{print $1}' | sort -u)
default_count=$(echo "$default_ids" | sed '/^$/d' | wc -l | tr -d ' ')
echo "Usable in default region ($DEFAULT_REGION): $default_count" >&2

all_ids=$(echo "$usable_tsv" | awk -F'\t' '{print $1}' | sort -u)
all_count=$(echo "$all_ids" | sed '/^$/d' | wc -l | tr -d ' ')
echo "Usable across all scanned regions: $all_count" >&2

# --- Validate the curated patterns ------------------------------------------
# Patterns are matched with bash globbing ([[ id == pattern ]]) against the
# probe-verified usable Bedrock ids plus pi's ai-model-router catalog ids
# (router models are not probed by this script; catalog presence is enough).
strip_pin() {
  case "$1" in
    *:off|*:minimal|*:low|*:medium|*:high|*:xhigh|*:max) echo "${1%:*}" ;;
    *) echo "$1" ;;
  esac
}

router_catalog=$(pi --list-models 2>/dev/null | awk '$1=="ai-model-router"{print $2}' | sort -u)
printf '%s\n%s\n' "$all_ids" "$router_catalog" | sed '/^$/d' | sort -u > "$workdir/matchable_ids"

: > "$workdir/covered_ids"
dead=0
echo "Validating ${#CURATED_PATTERNS[@]} curated pattern(s) against currently invocable models:" >&2
for raw_pat in "${CURATED_PATTERNS[@]}"; do
  pat=$(strip_pin "$raw_pat")
  : > "$workdir/pat_matches"
  while IFS= read -r id; do
    [[ "$id" == $pat ]] && echo "$id" >> "$workdir/pat_matches"
  done < "$workdir/matchable_ids"
  n=$(wc -l < "$workdir/pat_matches" | tr -d ' ')
  if [[ "$n" -eq 0 ]]; then
    echo "  DEAD PATTERN: $raw_pat matches nothing currently invocable (model retired or renamed?)" >&2
    dead=$((dead+1))
  else
    cat "$workdir/pat_matches" >> "$workdir/covered_ids"
  fi
done
if [[ "$dead" -eq 0 ]]; then echo "  all patterns matched at least one invocable model" >&2; fi

uncovered=$(comm -23 <(echo "$all_ids") <(sort -u "$workdir/covered_ids"))
if [[ -n "$uncovered" ]]; then
  echo "Usable Bedrock model(s) covered by NO pattern (add a pattern to offer them):" >&2
  echo "$uncovered" | sed 's/^/  /' >&2
fi

# Warn about hand-added enabledModels entries this write would drop: anything
# already there that is neither a curated pattern nor a Bedrock-catalog id.
existing=$(jq -r '.enabledModels // [] | .[]' "$PI_SETTINGS" 2>/dev/null || true)
dropped=$(comm -23 \
  <(echo "$existing" | sed '/^$/d' | sort -u) \
  <(printf '%s\n%s\n' "${CURATED_PATTERNS[@]}" "$catalog" | sed '/^$/d' | sort -u))
if [[ -n "$dropped" ]]; then
  echo "Hand-added enabledModels entr(ies) the write would DROP (move into CURATED_PATTERNS to keep):" >&2
  echo "$dropped" | sed 's/^/  /' >&2
fi

if $dry_run; then
  echo "(--dry-run: settings.json / bedrock-models.json not modified)" >&2
  exit 0
fi

# Full region map, for bedrock-region-sync.ts and the pi-use / pi-region /
# pi-models zsh functions. Sorted by key (-S) so re-runs with an unchanged
# model set produce a clean, near-empty git diff instead of reshuffling every
# key based on that run's parallel-probe completion order (which is random).
map_json=$(echo "$usable_tsv" | jq -R -s -S '
  split("\n") | map(select(length > 0) | split("\t")) | map({key: .[0], value: .[1]}) | from_entries
')
printf '%s\n' "$map_json" | jq -S --arg region "$DEFAULT_REGION" --arg gen "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{generatedAt: $gen, defaultRegion: $region, models: .}' > "$BEDROCK_MODELS_JSON"
echo "Wrote $(echo "$usable_tsv" | wc -l | tr -d ' ') model(s) to $BEDROCK_MODELS_JSON" >&2

# Write the curated pattern list verbatim. The validation report above is
# the review step: dead patterns and uncovered models are surfaced, never
# auto-fixed. jq preserves every other setting untouched.
enabled_models_json=$(printf '%s\n' "${CURATED_PATTERNS[@]}" | jq -R . | jq -s .)
tmp=$(mktemp)
jq --argjson models "$enabled_models_json" '.enabledModels = $models' "$PI_SETTINGS" > "$tmp"
mv "$tmp" "$PI_SETTINGS"
echo "Updated enabledModels in $PI_SETTINGS (${#CURATED_PATTERNS[@]} curated patterns)" >&2
