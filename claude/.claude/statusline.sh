#!/usr/bin/env bash
# Native Claude Code status line (inspired by pi's status-bar.ts).
#
# Replaces the default footer content with a two-line, right-justified bar:
#
#   <project>  ⎇ <branch> ●<dirty> ↑<ahead> ↓<behind>          <model> ✦<effort>
#   <session>  ↑<in> ↓<out> ⊕<cache>  $<cost>          [██████░░░░] <pct>%  <tok>/<win>  ▸<free>
#
# Element legend:
#   <project>   basename of the current working directory              (workspace.current_dir)
#   ⎇ <branch>  current git branch                                     (git)
#   ●<dirty>    count of uncommitted (working-tree + staged) changes    (git)
#   ↑<ahead>    commits ahead of upstream                              (git)
#   ↓<behind>   commits behind upstream                                (git)
#   <model>     active model display name                              (model.display_name)
#   ✦<effort>   reasoning / thinking level: low|medium|high|xhigh|max  (effort.level, thinking.enabled)
#   <session>   custom session name, if set with --name / /rename      (session_name)
#   ↑<in>       fresh input tokens in the last turn                    (context_window.current_usage.input_tokens)
#   ↓<out>      output tokens in the last turn                         (context_window.current_usage.output_tokens)
#   ⊕<cache>    cache read + write tokens in the last turn             (context_window.current_usage.cache_*)
#   $<cost>     estimated session cost in USD                          (cost.total_cost_usd)
#   [bar]       context-window usage bar, colored by fill (grn/ylw/red)(context_window.used_percentage)
#   <pct>%      percent of the context window used                     (context_window.used_percentage)
#   <tok>/<win> tokens in context / total context window SIZE          (context_window.total_input_tokens / context_window_size)
#   ▸<free>     tokens remaining before the window is full             (context_window_size - total_input_tokens)
#
# On terminals narrower than 80 cols it collapses to a single compact line.
# Git working-tree state is cached per session (5s) to keep the frequent
# refresh path fast. Claude Code sets $COLUMNS before running us, which we use
# to right-justify the second cluster of each line.

input=$(cat)
export LANG="${LANG:-en_US.UTF-8}"

j() { printf '%s' "$input" | jq -r "$1"; }

# --- Fields from the JSON payload ---
MODEL=$(j '.model.display_name // "?"')
DIR=$(j '.workspace.current_dir // .cwd // ""')
SESSION_ID=$(j '.session_id // "nosession"')
SESSION_NAME=$(j '.session_name // empty')
EFFORT=$(j '.effort.level // empty')
THINKING=$(j '.thinking.enabled // false')
PCT=$(j '.context_window.used_percentage // 0' | cut -d. -f1)
CTX_TOKENS=$(j '.context_window.total_input_tokens // 0')
WIN=$(j '.context_window.context_window_size // 0')
IN_TOKENS=$(j '.context_window.current_usage.input_tokens // .context_window.total_input_tokens // 0')
OUT_TOKENS=$(j '.context_window.current_usage.output_tokens // .context_window.total_output_tokens // 0')
CACHE_READ=$(j '.context_window.current_usage.cache_read_input_tokens // 0')
CACHE_WRITE=$(j '.context_window.current_usage.cache_creation_input_tokens // 0')
COST=$(j '.cost.total_cost_usd // 0')
CACHE_TOKENS=$((CACHE_READ + CACHE_WRITE))
FREE_TOKENS=$((WIN > CTX_TOKENS ? WIN - CTX_TOKENS : 0))

# --- Colors ---
CYAN='\033[36m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'
BLUE='\033[34m'; MAGENTA='\033[35m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

# --- Directory label ---
DIR_LABEL="${DIR##*/}"; [ -z "$DIR_LABEL" ] && DIR_LABEL="~"

# --- Token formatting: n < 1k plain, < 1M as k, else M (mirrors pi's fmtTokens) ---
fmt_tokens() {
    awk -v n="$1" 'BEGIN{
        if (n < 1000) printf "%d", n;
        else if (n < 1000000) printf "%.*fk", (n < 10000 ? 1 : 0), n/1000;
        else printf "%.1fM", n/1000000;
    }'
}
TOK_IN=$(fmt_tokens "$IN_TOKENS")
TOK_OUT=$(fmt_tokens "$OUT_TOKENS")
TOK_CACHE=$(fmt_tokens "$CACHE_TOKENS")
TOK_CTX=$(fmt_tokens "$CTX_TOKENS")
TOK_WIN=$(fmt_tokens "$WIN")
TOK_FREE=$(fmt_tokens "$FREE_TOKENS")
COST_FMT=$(printf '$%.3f' "$COST")

# --- Git info, cached per session to avoid slow calls on every refresh ---
CACHE_FILE="/tmp/statusline-git-cache-$SESSION_ID"
cache_is_stale() {
    [ ! -f "$CACHE_FILE" ] || \
    [ $(($(date +%s) - $(stat -f %m "$CACHE_FILE" 2>/dev/null || stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0))) -gt 5 ]
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

# --- Git segment ---
GIT_SEG=""
if [ -n "$BRANCH" ]; then
    GIT_SEG="${DIM}⎇ ${RESET}${BLUE}${BRANCH}${RESET}"
    [ "${DIRTY:-0}" -gt 0 ] 2>/dev/null && GIT_SEG="${GIT_SEG} ${YELLOW}●${DIRTY}${RESET}"
    [ "${AHEAD:-0}" -gt 0 ] 2>/dev/null && GIT_SEG="${GIT_SEG} ${DIM}↑${AHEAD}${RESET}"
    [ "${BEHIND:-0}" -gt 0 ] 2>/dev/null && GIT_SEG="${GIT_SEG} ${DIM}↓${BEHIND}${RESET}"
fi

# --- Thinking / effort tag ---
THINK_SEG=""
if [ -n "$EFFORT" ]; then
    THINK_SEG="${MAGENTA}✦${EFFORT}${RESET}"
elif [ "$THINKING" = "true" ]; then
    THINK_SEG="${MAGENTA}✦on${RESET}"
fi

# --- Context bar (10 slots, colored by usage threshold) ---
if [ "$PCT" -ge 90 ]; then BAR_COLOR="$RED"
elif [ "$PCT" -ge 70 ]; then BAR_COLOR="$YELLOW"
else BAR_COLOR="$GREEN"; fi
FILLED=$((PCT / 10)); [ "$FILLED" -gt 10 ] && FILLED=10; [ "$FILLED" -lt 0 ] && FILLED=0
EMPTY=$((10 - FILLED))
BAR=""
[ "$FILLED" -gt 0 ] && printf -v F "%${FILLED}s" && BAR="${F// /█}"
[ "$EMPTY" -gt 0 ] && printf -v E "%${EMPTY}s" && BAR="${BAR}${E// /░}"
# Free-tokens color tracks how much room is left.
if [ "$PCT" -ge 90 ]; then FREE_COLOR="$RED"
elif [ "$PCT" -ge 70 ]; then FREE_COLOR="$YELLOW"
else FREE_COLOR="$DIM"; fi

# --- Width-aware right-justification (visible width = codepoints sans ANSI) ---
WIDTH=${COLUMNS:-120}
vwidth() { local s; s=$(printf '%b' "$1" | sed $'s/\033\\[[0-9;]*m//g'); printf '%s' "${#s}"; }
join_lr() {
    local left="$1" right="$2" lw rw gap
    lw=$(vwidth "$left"); rw=$(vwidth "$right")
    gap=$((WIDTH - lw - rw)); [ "$gap" -lt 2 ] && gap=2
    printf '%b%*s%b' "$left" "$gap" "" "$right"
}

# --- Narrow terminals: single compact line ---
if [ "$WIDTH" -lt 80 ]; then
    LINE="${BOLD}${CYAN}${DIR_LABEL}${RESET}"
    [ -n "$GIT_SEG" ] && LINE="${LINE} ${GIT_SEG}"
    LINE="${LINE} ${DIM}·${RESET} ${BAR_COLOR}${PCT}%${RESET} ${DIM}${TOK_CTX}/${TOK_WIN}${RESET} ${DIM}·${RESET} ${GREEN}${COST_FMT}${RESET} ${DIM}·${RESET} ${DIM}${MODEL}${RESET}"
    printf '%b\n' "$LINE"
    exit 0
fi

# --- Line 1: project + git   |   model + thinking ---
L1="${BOLD}${CYAN}${DIR_LABEL}${RESET}"
[ -n "$GIT_SEG" ] && L1="${L1}  ${GIT_SEG}"
R1="${DIM}${MODEL}${RESET}"
[ -n "$THINK_SEG" ] && R1="${R1} ${THINK_SEG}"

# --- Line 2: session + tokens + cost   |   context bar + pct + tok/win + free ---
L2=""
[ -n "$SESSION_NAME" ] && L2="${CYAN}${SESSION_NAME}${RESET}  "
L2="${L2}${DIM}↑${RESET}${TOK_IN} ${DIM}↓${RESET}${TOK_OUT} ${DIM}⊕${RESET}${TOK_CACHE}  ${GREEN}${COST_FMT}${RESET}"
R2="${BAR_COLOR}[${BAR}]${RESET} ${PCT}% ${DIM}${TOK_CTX}/${TOK_WIN}${RESET} ${DIM}▸${RESET}${FREE_COLOR}${TOK_FREE}${RESET}"

printf '%b\n' "$(join_lr "$L1" "$R1")"
printf '%b\n' "$(join_lr "$L2" "$R2")"
