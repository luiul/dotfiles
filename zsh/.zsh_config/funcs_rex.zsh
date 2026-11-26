# Close the caller after Worktrunk has removed its checkout and moved the shell.
_wt_rex_checkout() {
  [[ ${REX_SESSION-} == session:?* && ${REX_BLOCK-} == block:?* ]] || return 1
  [[ -z ${COMPLETE-} && ${WORKTRUNK_AGENT-} != 1 && -z ${GIT_DIR-}${GIT_WORK_TREE-} ]] || return 1
  local root
  root=$(command git rev-parse --show-toplevel 2>/dev/null) || return 1
  [[ -d $root ]] || return 1
  print -r -- "${root:A}"
}

# Coppice runs the wt binary, so its parent shell must finish caller navigation.
# Keep this lifecycle policy with the Worktrunk integration, not in Coppice.
_wt_rex_wrap_coppice() {
  (( $+functions[coppice] )) || return 0
  [[ $functions[coppice] == *'_wt_coppice_shell_orig "$@"'* ]] && return 0
  functions[_wt_coppice_shell_orig]=$functions[coppice]
  coppice() {
    local checkout= destination= entry
    if [[ ${1-} == remove && -n ${REX_BLOCK-} && -o interactive && -t 0 && -t 1 && $ZSH_SUBSHELL == 0 ]]; then
      checkout=$(_wt_rex_checkout) || checkout=
      if [[ -n $checkout ]]; then
        entry=$(command git worktree list --porcelain 2>/dev/null) || checkout=
        entry=${entry%%$'\n'*}
        if [[ $entry == 'worktree '* ]]; then
          destination=${entry#worktree }
          [[ -d $destination && ${destination:A} != "$checkout" ]] || checkout=
        else
          checkout=
        fi
      fi
    fi
    _wt_coppice_shell_orig "$@"
    local -i result=$?
    if [[ -n $checkout && ! -e $checkout && ! -L $checkout ]]; then
      # Move out even after a partial batch failure, but close only on success.
      if builtin cd -- "$destination"; then
        if (( result == 0 )); then
          _wt_rex_close_removed_tab "$checkout" || print -u2 'Worktree removed, but the Rex tab could not be closed.'
        fi
      else
        print -u2 'Worktree removed, but the shell could not enter the main worktree.'
      fi
    fi
    return $result
  }
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
  local args
  args=$(command jq -cn --arg session "$REX_SESSION" --arg block "$REX_BLOCK" '{session: $session, block: $block}') || return 0
  # The close hangs up this shell. One bounded client must survive HUP to finish
  # empty-session cleanup. It checks detached blocks as well as visible tabs.
  # Rex has no conditional destroy. Luis accepts a concurrent-create race here.
  (
    trap '' HUP
    # Terminal teardown can kill the caller process group, not just send HUP.
    # A fork lets setsid move the bounded supervisor out of that group.
    command /usr/bin/perl -e '
      use POSIX qw(WNOHANG setsid);
      my $supervisor = fork(); defined $supervisor or die "Cannot fork cleanup: $!";
      if ($supervisor) {
        waitpid($supervisor, 0);
        exit(($? & 127) ? 1 : ($? >> 8));
      }
      defined setsid() or die "Cannot detach cleanup: $!";
      my $pid = fork(); defined $pid or die "Cannot fork Rex: $!";
      if (!$pid) { exec @ARGV; die "Cannot start Rex: $!"; }
      $SIG{ALRM} = sub {
        # Only an unreaped child still owns this PID at the signal boundary.
        if (waitpid($pid, WNOHANG) == 0) {
          kill "TERM", $pid;
          sleep 1;
          if (waitpid($pid, WNOHANG) == 0) {
            kill "KILL", $pid;
            waitpid($pid, 0);
          }
        }
        exit 124;
      };
      alarm 10;
      waitpid($pid, 0);
      alarm 0;
      exit(($? & 127) ? 1 : ($? >> 8));
    ' -- "${rex_cli[@]}" do -s "$REX_SESSION" --args "$args" -e '
      local function call(method, args)
        local value, err = rex.call(method, args)
        if value == nil then
          rex.log("error", err)
          rex.stop(1)
        end
        return value
      end
      local id = rex.args.session
      call("block.close", {session_id=id, block_id=rex.args.block})
      local view = call("session.view", {session_id=id})
      if view.session_id ~= id or (view.windows ~= nil and #view.windows ~= 0) then return end
      local remaining = call("session.list_blocks", {session_id=id})
      if remaining.blocks ~= nil and #remaining.blocks ~= 0 then return end
      call("session.destroy", {session_id=id})
    '
  )
}
