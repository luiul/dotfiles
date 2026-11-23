# Close the caller after Worktrunk has removed its checkout and moved the shell.
_wt_rex_checkout() {
  [[ ${REX_SESSION-} == session:?* && ${REX_BLOCK-} == block:?* ]] || return 1
  [[ -z ${COMPLETE-} && ${WORKTRUNK_AGENT-} != 1 && -z ${GIT_DIR-}${GIT_WORK_TREE-} ]] || return 1
  local root
  root=$(command git rev-parse --show-toplevel 2>/dev/null) || return 1
  [[ -d $root ]] || return 1
  print -r -- "${root:A}"
}

_wt_rex_close_removed_tab() {
  local checkout=$1
  # Worktrunk can return success for an unrelated checkout or for a branch alone.
  [[ ${PWD:A} != "$checkout" && -d $PWD ]] || return 0
  zmodload -i zsh/parameter || return 0
  (( ${#jobstates} == 0 )) || return 0
  # A normal wt remove may still be finishing in the background after the cd.
  # Wait briefly for the old path to disappear. Never close on a timeout.
  if [[ -e $checkout || -L $checkout ]]; then
    zmodload -i zsh/datetime || return 0
    local -F deadline=$(( EPOCHREALTIME + 3 ))
    while [[ -e $checkout || -L $checkout ]]; do
      (( EPOCHREALTIME < deadline )) || return 0
      command sleep 0.1 || return 0
    done
  fi

  local rex_bin=${commands[rex]-} root app identity inventory window process
  if [[ -z $rex_bin ]]; then
    for root in /Applications "$HOME/Applications"; do
      for app in Rex.app 'Rex Beta.app'; do
        rex_bin="$root/$app/Contents/Helpers/Rex Server.rex/Contents/MacOS/rex"
        [[ -x $rex_bin ]] && break 2
      done
    done
    [[ -x $rex_bin ]] || return 0
  fi
  local -a rex_cli=("$rex_bin" --autostart=false --timeout 2s)
  identity=$(command "${rex_cli[@]}" whoami --json 2>/dev/null) || return 0
  local endpoint host
  endpoint=$(command jq -er '.endpoint | select(startswith("unix:///"))' <<< "$identity") || return 0
  host=$(command jq -er '.host_id | select(type == "string" and length > 0)' <<< "$identity") || return 0
  rex_cli+=(-S "$endpoint")

  # The PTY child is this shell, or macOS login is its direct parent.
  process=$(command "${rex_cli[@]}" block call -s "$REX_SESSION" -b "$REX_BLOCK" process 2>/dev/null) || return 0
  command jq -e --argjson shell "$$" --argjson parent "$PPID" '
    .last_exit == null and (.child.pid == $shell or (.child.pid == $parent and .child.path == "/usr/bin/login"))
  ' <<< "$process" >/dev/null || return 0

  # Check the layout last. Rex has no conditional close for the whole tab.
  # Closing by pane ID protects any sibling added after this snapshot.
  inventory=$(command "${rex_cli[@]}" session inspect "$REX_SESSION" --json 2>/dev/null) || return 0
  window=$(command jq -er --arg session "$REX_SESSION" --arg block "$REX_BLOCK" --arg host "$host" '
    select(.session_id == $session)
    | [.windows[] | select([.layers[].blocks[] | {block_id, host_id}] == [{block_id: $block, host_id: $host}])]
    | select(length == 1) | .[0].window_id | select(startswith("window:"))
  ' <<< "$inventory") || return 0
  [[ ! -e $checkout && ! -L $checkout ]] || return 0
  command "${rex_cli[@]}" block close -s "$REX_SESSION" -w "$window" "$REX_BLOCK"
}
