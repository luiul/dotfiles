#!/usr/bin/env bash
# Native Claude Code status line, replicating the claude-hud expanded layout.
# Reads session JSON on stdin (see https://code.claude.com/docs/en/statusline)
# and prints a two-line status: identity/git on line 1, usage metrics on line 2.

input=$(cat)

j() { printf '%s' "$input" | jq -r "$1"; }

# --- Fields from the JSON payload ---
MODEL=$(j '.model.display_name // "?"')
DIR=$(j '.workspace.current_dir // .cwd // ""')
PROJECT=$(j '.workspace.project_dir // ""')
SESSION_ID=$(j '.session_id // "nosession"')
SESSION_NAME=$(j '.session_name // empty')
EFFORT=$(j '.effort.level // empty')
STYLE=$(j '.output_style.name // empty')
VERSION=$(j '.version // empty')
PCT=$(j '.context_window.used_percentage // 0' | cut -d. -f1)
IN_TOKENS=$(j '.context_window.total_input_tokens // 0')
OUT_TOKENS=$(j '.context_window.total_output_tokens // 0')
COST=$(j '.cost.total_cost_usd // 0')
DURATION_MS=$(j '.cost.total_duration_ms // 0')
LINES_ADDED=$(j '.cost.total_lines_added // 0')
LINES_REMOVED=$(j '.cost.total_lines_removed // 0')

# --- Colors ---
CYAN='\033[36m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'
BLUE='\033[34m'; MAGENTA='\033[35m'; DIM='\033[2m'; RESET='\033[0m'

# --- Directory label (basename of current dir) ---
DIR_LABEL="${DIR##*/}"
[ -z "$DIR_LABEL" ] && DIR_LABEL="~"

# --- Git info, cached per session to avoid slow calls on every refresh ---
CACHE_FILE="/tmp/statusline-git-cache-$SESSION_ID"
CACHE_MAX_AGE=5

cache_is_stale() {
    [ ! -f "$CACHE_FILE" ] || \
    [ $(($(date +%s) - $(stat -f %m "$CACHE_FILE" 2>/dev/null || stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0))) -gt $CACHE_MAX_AGE ]
}

if cache_is_stale; then
    if git rev-parse --git-dir > /dev/null 2>&1; then
        BRANCH=$(git branch --show-current 2>/dev/null)
        [ -z "$BRANCH" ] && BRANCH=$(git rev-parse --short HEAD 2>/dev/null)
        DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
        AHEAD=0; BEHIND=0
        COUNTS=$(git rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null)
        if [ -n "$COUNTS" ]; then
            BEHIND=$(printf '%s' "$COUNTS" | awk '{print $1}')
            AHEAD=$(printf '%s' "$COUNTS" | awk '{print $2}')
        fi
        printf '%s|%s|%s|%s\n' "$BRANCH" "$DIRTY" "$AHEAD" "$BEHIND" > "$CACHE_FILE"
    else
        printf '|||\n' > "$CACHE_FILE"
    fi
fi
IFS='|' read -r BRANCH DIRTY AHEAD BEHIND < "$CACHE_FILE"

# --- Build git segment ---
GIT_SEG=""
if [ -n "$BRANCH" ]; then
    GIT_SEG="${GREEN}🌿 ${BRANCH}${RESET}"
    [ "${DIRTY:-0}" -gt 0 ] 2>/dev/null && GIT_SEG="${GIT_SEG} ${YELLOW}●${DIRTY}${RESET}"
    [ "${AHEAD:-0}" -gt 0 ] 2>/dev/null && GIT_SEG="${GIT_SEG} ${CYAN}↑${AHEAD}${RESET}"
    [ "${BEHIND:-0}" -gt 0 ] 2>/dev/null && GIT_SEG="${GIT_SEG} ${MAGENTA}↓${BEHIND}${RESET}"
fi

# --- Context usage bar (10 chars, color by threshold) ---
if [ "$PCT" -ge 90 ]; then BAR_COLOR="$RED"
elif [ "$PCT" -ge 70 ]; then BAR_COLOR="$YELLOW"
else BAR_COLOR="$GREEN"; fi
FILLED=$((PCT / 10)); [ "$FILLED" -gt 10 ] && FILLED=10
EMPTY=$((10 - FILLED))
BAR=""
[ "$FILLED" -gt 0 ] && printf -v FILL "%${FILLED}s" && BAR="${FILL// /█}"
[ "$EMPTY" -gt 0 ] && printf -v PAD "%${EMPTY}s" && BAR="${BAR}${PAD// /░}"

# --- Token + cost + duration formatting ---
fmt_tokens() {
    local n=$1
    if [ "$n" -ge 1000000 ] 2>/dev/null; then awk "BEGIN{printf \"%.1fM\", $n/1000000}"
    elif [ "$n" -ge 1000 ] 2>/dev/null; then awk "BEGIN{printf \"%.1fk\", $n/1000}"
    else printf '%s' "$n"; fi
}
TOK_IN=$(fmt_tokens "$IN_TOKENS")
TOK_OUT=$(fmt_tokens "$OUT_TOKENS")
COST_FMT=$(printf '$%.2f' "$COST")
DUR_SEC=$((DURATION_MS / 1000)); MINS=$((DUR_SEC / 60)); SECS=$((DUR_SEC % 60))

# --- Line 1: identity + git ---
LINE1="${CYAN}[${MODEL}]${RESET} ${BLUE}📁 ${DIR_LABEL}${RESET}"
[ -n "$GIT_SEG" ] && LINE1="${LINE1} ${DIM}|${RESET} ${GIT_SEG}"
[ -n "$SESSION_NAME" ] && LINE1="${LINE1} ${DIM}|${RESET} ${SESSION_NAME}"
[ -n "$EFFORT" ] && LINE1="${LINE1} ${DIM}|${RESET} ${DIM}${EFFORT}${RESET}"
[ -n "$STYLE" ] && [ "$STYLE" != "default" ] && LINE1="${LINE1} ${DIM}|${RESET} ${DIM}${STYLE}${RESET}"

# --- Line 2: usage metrics ---
LINE2="${BAR_COLOR}${BAR}${RESET} ${PCT}%"
LINE2="${LINE2} ${DIM}|${RESET} ${YELLOW}${COST_FMT}${RESET}"
LINE2="${LINE2} ${DIM}|${RESET} ⏱️ ${MINS}m ${SECS}s"
LINE2="${LINE2} ${DIM}|${RESET} ${DIM}🔤 ${TOK_IN}→${TOK_OUT}${RESET}"
if [ "${LINES_ADDED:-0}" -gt 0 ] 2>/dev/null || [ "${LINES_REMOVED:-0}" -gt 0 ] 2>/dev/null; then
    LINE2="${LINE2} ${DIM}|${RESET} ${GREEN}+${LINES_ADDED}${RESET}${DIM}/${RESET}${RED}-${LINES_REMOVED}${RESET}"
fi
[ -n "$VERSION" ] && LINE2="${LINE2} ${DIM}| v${VERSION}${RESET}"

printf '%b\n' "$LINE1"
printf '%b\n' "$LINE2"
