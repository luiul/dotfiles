#!/usr/bin/env bash
# Native Claude Code status line.
#
# Two left-anchored lines (nothing is right-justified, so Claude Code's own
# right-edge notifications and the verbose-mode token counter never clip us):
#
#   <project>  ⎇ <branch> ●<dirty> ↑<ahead> ↓<behind>  ·  <model> ✦<effort>
#   [██████░░░░] <pct>%  <ctx>/<win>  ▸<free> free  ·  ↑<in> ↓<out> ⊕<cache>  ·  $<cost>
#
# Element legend:
#   <project>   basename of the current working directory              (workspace.current_dir)
#   ⎇ <branch>  current git branch                                     (git)
#   ●<dirty>    count of uncommitted (working-tree + staged) changes    (git)
#   ↑<ahead>    commits ahead of upstream                              (git)
#   ↓<behind>   commits behind upstream                                (git)
#   <model>     active model display name                              (model.display_name)
#   ✦<effort>   reasoning effort: low|medium|high|xhigh|max, or "think" (effort.level / thinking.enabled)
#   [bar]       context-window usage bar, colored by fill (grn/ylw/red)(context_window.used_percentage)
#   <pct>%      percent of the context window used                     (context_window.used_percentage)
#   <ctx>/<win> tokens in context / total context window SIZE          (context_window.total_input_tokens / context_window_size)
#   ▸<free>     tokens remaining before the window is full             (context_window_size - total_input_tokens)
#   ↑<in>       fresh input tokens in the last turn                    (context_window.current_usage.input_tokens)
#   ↓<out>      output tokens in the last turn                         (context_window.current_usage.output_tokens)
#   ⊕<cache>    cache read + write tokens in the last turn             (context_window.current_usage.cache_*)
#   $<cost>     estimated session cost in USD                          (cost.total_cost_usd)
#
# On terminals narrower than 60 cols it collapses to a single compact line.
# Git working-tree state is cached per session (5s) to keep the frequent
# refresh path fast.

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
IN_TOKENS=$(j '.context_window.current_usage.input_tokens // 0')
OUT_TOKENS=$(j '.context_window.current_usage.output_tokens // .context_window.total_output_tokens // 0')
CACHE_READ=$(j '.context_window.current_usage.cache_read_input_tokens // 0')
CACHE_WRITE=$(j '.context_window.current_usage.cache_creation_input_tokens // 0')
COST=$(j '.cost.total_cost_usd // 0')
CACHE_TOKENS=$((CACHE_READ + CACHE_WRITE))
# Remaining room in the window. Only meaningful once the window size is known.
FREE_TOKENS=$((WIN > CTX_TOKENS ? WIN - CTX_TOKENS : 0))

# --- Colors ---
CYAN='\033[36m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'
BLUE='\033[34m'; MAGENTA='\033[35m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
SEP="${DIM}·${RESET}"

# --- Directory label ---
DIR_LABEL="${DIR##*/}"; [ -z "$DIR_LABEL" ] && DIR_LABEL="~"

# --- Token formatting: n < 1k plain, < 1M as k, else M ---
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

# --- Effort / thinking tag ---
THINK_SEG=""
if [ -n "$EFFORT" ]; then
    THINK_SEG="${MAGENTA}✦${EFFORT}${RESET}"
elif [ "$THINKING" = "true" ]; then
    THINK_SEG="${MAGENTA}✦think${RESET}"
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

WIDTH=${COLUMNS:-120}

# --- Narrow terminals: single compact line ---
if [ "$WIDTH" -lt 60 ]; then
    LINE="${BOLD}${CYAN}${DIR_LABEL}${RESET}"
    [ -n "$GIT_SEG" ] && LINE="${LINE} ${GIT_SEG}"
    LINE="${LINE} ${SEP} ${BAR_COLOR}${PCT}%${RESET} ${SEP} ${GREEN}${COST_FMT}${RESET} ${SEP} ${DIM}${MODEL}${RESET}"
    [ -n "$THINK_SEG" ] && LINE="${LINE} ${THINK_SEG}"
    printf '%b\n' "$LINE"
    exit 0
fi

# --- Line 1: project + git · model + effort  (all left-anchored) ---
L1="${BOLD}${CYAN}${DIR_LABEL}${RESET}"
[ -n "$GIT_SEG" ] && L1="${L1}  ${GIT_SEG}"
L1="${L1}  ${SEP}  ${DIM}${MODEL}${RESET}"
[ -n "$THINK_SEG" ] && L1="${L1} ${THINK_SEG}"

# --- Line 2: context bar + pct + tok/win + free · turn tokens · cost  (left-anchored) ---
L2="${BAR_COLOR}[${BAR}]${RESET} ${PCT}% ${DIM}${TOK_CTX}/${TOK_WIN}${RESET}"
# Show free-room only once the window size is known (avoids a bogus "0 free").
[ "${WIN:-0}" -gt 0 ] 2>/dev/null && L2="${L2} ${DIM}▸${RESET}${FREE_COLOR}${TOK_FREE}${RESET}${DIM} free${RESET}"
L2="${L2}  ${SEP}  ${DIM}↑${RESET}${TOK_IN} ${DIM}↓${RESET}${TOK_OUT} ${DIM}⊕${RESET}${TOK_CACHE}"
L2="${L2}  ${SEP}  ${GREEN}${COST_FMT}${RESET}"
[ -n "$SESSION_NAME" ] && L2="${L2}  ${SEP}  ${CYAN}${SESSION_NAME}${RESET}"

printf '%b\n' "$L1"
printf '%b\n' "$L2"
