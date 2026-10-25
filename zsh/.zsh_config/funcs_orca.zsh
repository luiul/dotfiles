# Register a repo in Orca and show its wt-created worktrees.
orca-watch() {
  emulate -L zsh
  if (( $# > 1 )); then
    print -u2 -- 'Usage: orca-watch [path]'
    return 2
  fi

  local target="${1:-$PWD}"
  # Match cop's expanduser behavior for a quoted home-relative path too.
  [[ $target == '~/'* ]] && target="$HOME/${target#\~/}"
  local common_dir=""
  common_dir=$(command git -C "$target" rev-parse --path-format=absolute --git-common-dir) || return
  local worktrees=""
  worktrees=$(command git --git-dir="$common_dir" worktree list --porcelain -z) || return
  local root="${${worktrees%%$'\0'*}#worktree }"
  # Git's separate-git-dir layout reports the metadata directory as the main
  # worktree. Use the checkout itself when called from that main checkout.
  local git_dir=""
  git_dir=$(command git -C "$target" rev-parse --absolute-git-dir) || return
  if [[ $git_dir == $common_dir ]]; then
    root=$(command git -C "$target" rev-parse --show-toplevel) || return
  fi
  if [[ ! -d $root || ${worktrees%%$'\0'*} != 'worktree '* || $worktrees == *$'\0bare'* ]]; then
    print -u2 -- 'orca-watch: expected a repo with a main checkout, not a bare repo.'
    return 1
  fi
  local checkout=""
  checkout=$(command git -C "$root" rev-parse --show-toplevel) || return
  if [[ $checkout != $root ]]; then
    print -u2 -- 'orca-watch: cannot resolve the main checkout.'
    return 1
  fi

  local dependency=""
  for dependency in orca jq; do
    if ! (( $+commands[$dependency] )); then
      print -u2 -- "orca-watch: $dependency is not installed."
      return 1
    fi
  done

  local reply=""
  local -i show_exit=0
  reply=$(command orca repo show --repo "path:$root" --json) || show_exit=$?
  if (( show_exit )) || ! print -r -- "$reply" | command jq -e '.ok == true' >/dev/null 2>&1; then
    if ! print -r -- "$reply" | command jq -e '.ok == false and .error.code == "repo_not_found"' >/dev/null 2>&1; then
      [[ -n $reply ]] && print -ru2 -- "$reply"
      return 1
    fi
    reply=$(command orca repo add --path "$root" --json) || { print -ru2 -- "$reply"; return 1; }
    if ! print -r -- "$reply" | command jq -e '.ok == true' >/dev/null 2>&1; then
      print -ru2 -- "$reply"
      return 1
    fi
  fi

  reply=$(command orca repo set --repo "path:$root" --external-worktree-visibility show --json) || { print -ru2 -- "$reply"; return 1; }
  if ! print -r -- "$reply" | command jq -e '.ok == true' >/dev/null 2>&1; then
    print -ru2 -- "$reply"
    return 1
  fi
  print -r -- "Orca is watching $root (external worktrees: show)."
}

alias owa=orca-watch
