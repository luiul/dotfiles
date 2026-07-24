# Worktrunk (wt) helpers.
#
# Global wt config lives in the `worktrunk` stow package
# (~/.config/worktrunk/config.toml): it symlinks .venv, copies gitignored
# files, opens a new VS Code window, and registers the repo into
# ~/.cache/wt/known-repos on `post-start` (i.e. whenever `wt switch --create`
# actually creates a worktree). Project-specific setup (e.g. tardis-community's
# per-pipeline `dbt deps`) lives in the same file under [projects."..."].
# These functions only handle branch naming and cross-repo cleanup, and stay
# out of the way of those hooks so VS Code doesn't open twice.

# Prompt for a short branch description (or fall back to a timestamp id),
# then create or reuse a worktree for it via `wt switch`. Ticket/PR
# references are deliberately not part of this — attach those when opening
# the PR instead.
wtnew() {
	if [[ "$1" == "-h" || "$1" == "--help" ]]; then
		echo "Usage: wtnew [WT_SWITCH_OPTIONS...]"
		echo
		echo "Prompts for a short branch description and creates/reuses a git"
		echo "worktree for it via 'wt switch'. Leave it blank to fall back to a"
		echo "timestamp-based branch name (wip-YYYYMMDD-HHMMSS)."
		echo
		echo "Any extra arguments are forwarded to 'wt switch', e.g.:"
		echo "  wtnew --base develop"
		return 0
	fi

	if ! command -v wt &>/dev/null; then
		echo "Error: 'wt' (worktrunk) is not installed. Run: brew install worktrunk" >&2
		return 1
	fi

	if ! git rev-parse --is-inside-work-tree &>/dev/null; then
		echo "Error: not inside a git repository." >&2
		return 1
	fi

	# Show what's already in flight for this repo before asking for a new
	# description — avoids accidentally starting a near-duplicate of work
	# that's already sitting in another worktree. Resolved via git-common-dir
	# (not --show-toplevel) so this also works correctly when wtnew is run
	# from inside an existing worktree, not just the main checkout.
	if command -v jq &>/dev/null; then
		local repo_root
		repo_root=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
		[[ -n "$repo_root" ]] && repo_root=$(dirname "$repo_root")
		if [[ -n "$repo_root" ]]; then
			local existing
			existing=$(wt -C "$repo_root" --config-set list.json-schema=1 list --format json 2>/dev/null \
				| LC_ALL=C tr -d '\033' \
				| jq -r '.[] | select(.is_main != true and .is_current != true) | "  \(.branch)"' 2>/dev/null)
			if [[ -n "$existing" ]]; then
				echo "Existing worktrees for $(basename "$repo_root"):"
				echo "$existing"
			fi
		fi
	fi

	local description
	read "description?Short branch description (optional, enter for a timestamp id): "

	local branch
	if [[ -z "$description" ]]; then
		branch="wip-$(date +%Y%m%d-%H%M%S)"
		echo "No description entered — using timestamp branch: $branch"
	else
		branch=$(echo "$description" | tr '[:upper:]' '[:lower:]' | tr -s '[:space:]/_' '-' | tr -cd '[:alnum:]-')
		branch="${branch#-}"
		branch="${branch%-}"
		# Cap at 40 chars so a rambling description doesn't produce an unwieldy
		# branch/directory name; cut on a '-' boundary rather than mid-word.
		if [[ ${#branch} -gt 40 ]]; then
			branch="${branch[1,40]}"
			branch="${branch%-*}"
		fi
		if [[ -z "$branch" ]]; then
			branch="wip-$(date +%Y%m%d-%H%M%S)"
			echo "Description had no usable characters — using timestamp branch: $branch"
		fi
	fi

	echo "Worktree branch: $branch"

	if git show-ref --verify --quiet "refs/heads/$branch"; then
		echo "Branch '$branch' already exists — reusing its worktree."
		# post-start hooks (VS Code, venv, copy-ignored) only fire on
		# creation, so open the editor ourselves when reusing.
		wt switch "$branch" "$@" && code -n .
	else
		# Creation-time setup (VS Code, venv symlink, copy-ignored, repo
		# registration) is handled by the global post-start hooks in
		# worktrunk's config.
		wt switch --create "$branch" "$@"
	fi
}
alias wtn=wtnew

# Remove worktrees whose last commit is older than a given age, across every
# repo worktrunk has seen (~/.cache/wt/known-repos, populated by the
# `registry` post-start hook) plus the repo you're currently standing in —
# so this is safe to run from any directory, in any repo, at any time.
#
# Safety rails, since PRs often sit open for review before merging:
#   - never touches the main worktree or the one you're standing in
#   - skips worktrees with uncommitted changes (never force-removes)
#   - skips branches with an open GitHub PR, when `gh` is available
#   - branch deletion still follows wt's own merge-safety rules (a worktree
#     for an unmerged branch is removed, but the branch itself is kept,
#     unless -D/--force-delete is passed)
# Format a KB integer (as from `du -sk`) as a short human-readable size.
_wtclean_human_kb() {
	local kb=$1
	if ((kb >= 1048576)); then
		printf '%.1fG' $((kb / 1048576.0))
	elif ((kb >= 1024)); then
		printf '%.1fM' $((kb / 1024.0))
	else
		printf '%dK' "$kb"
	fi
}

wtclean() {
	if [[ "$1" == "-h" || "$1" == "--help" ]]; then
		echo "Usage: wtclean [WEEKS] [-y|--yes] [-n|--dry-run] [-D|--force-delete] [-v|--verbose] [--repo NAME]"
		echo
		echo "Removes worktrees whose last commit is older than WEEKS (default: 2),"
		echo "across every repo in ~/.cache/wt/known-repos plus the current repo."
		echo
		echo "  -n, --dry-run       List candidates without removing anything"
		echo "  -y, --yes           Skip the confirmation prompt"
		echo "  -D, --force-delete  Also delete unmerged branches (default: keep them)"
		echo "  -v, --verbose       Also list worktrees under WEEKS old (kept, for context)"
		echo "  --repo NAME         Only scan the repo whose directory basename is NAME"
		echo
		echo "Skips: the main worktree, the current worktree, dirty worktrees, and"
		echo "branches with an open GitHub PR. Reports, per worktree, whether removal"
		echo "will also delete the branch (merged) or just free the worktree (unmerged,"
		echo "kept unless -D), an on-disk size estimate, a total reclaimable size, and"
		echo "a final summary."
		return 0
	fi

	if ! command -v wt &>/dev/null; then
		echo "Error: 'wt' (worktrunk) is not installed." >&2
		return 1
	fi
	if ! command -v jq &>/dev/null; then
		echo "Error: 'jq' is required (brew install jq)." >&2
		return 1
	fi

	local weeks=2 dry_run=false auto_yes=false force_delete=false verbose=false repo_filter=""
	while [[ $# -gt 0 ]]; do
		case "$1" in
		-n | --dry-run) dry_run=true ;;
		-y | --yes) auto_yes=true ;;
		-D | --force-delete) force_delete=true ;;
		-v | --verbose) verbose=true ;;
		--repo)
			shift
			repo_filter="$1"
			;;
		[0-9]*) weeks="$1" ;;
		*)
			echo "Error: unknown argument '$1'" >&2
			return 1
			;;
		esac
		shift
	done

	# Color prefixes for scannability, disabled when stdout isn't a terminal
	# (piped to a file, captured by another tool, etc.).
	local c_green="" c_yellow="" c_red="" c_reset=""
	if [[ -t 1 ]]; then
		c_green=$'\e[32m'
		c_yellow=$'\e[33m'
		c_red=$'\e[31m'
		c_reset=$'\e[0m'
	fi

	# Repos to scan: everything registered by the post-start hook, plus the
	# repo we're standing in right now (covers the case where the registry
	# hasn't picked up this repo yet, e.g. before the first wtnew here).
	local -a repos
	local registry="$HOME/.cache/wt/known-repos"
	if [[ -f "$registry" ]]; then
		while IFS= read -r line; do
			[[ -n "$line" ]] && repos+=("$line")
		done <"$registry"
	fi

	local cwd_repo
	# git-common-dir always resolves to the MAIN repo's .git, whether run from
	# the main checkout or any linked worktree — unlike --show-toplevel, which
	# returns whichever worktree you're standing in. Using --show-toplevel here
	# would add the current worktree's own path as a second, differently-named
	# "repo", and every worktree of that repo would then get scanned twice.
	cwd_repo=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
	[[ -n "$cwd_repo" ]] && cwd_repo=$(dirname "$cwd_repo")
	if [[ -n "$cwd_repo" ]]; then
		local already=false r
		for r in "${repos[@]}"; do
			[[ "$r" == "$cwd_repo" ]] && already=true && break
		done
		$already || repos+=("$cwd_repo")
	fi

	if [[ ${#repos[@]} -eq 0 ]]; then
		echo "No known repos to clean. Run wtnew at least once, or cd into a repo." >&2
		return 1
	fi

	if [[ -n "$repo_filter" ]]; then
		local -a filtered
		local fr
		for fr in "${repos[@]}"; do
			[[ "$(basename "$fr")" == "$repo_filter" ]] && filtered+=("$fr")
		done
		if [[ ${#filtered[@]} -eq 0 ]]; then
			echo "Error: no known repo named '$repo_filter'. Known repos:" >&2
			for fr in "${repos[@]}"; do echo "  $(basename "$fr")" >&2; done
			return 1
		fi
		repos=("${filtered[@]}")
	fi

	local now=$(date +%s)
	local cutoff=$((now - weeks * 7 * 24 * 3600))
	local have_gh=false
	command -v gh &>/dev/null && have_gh=true

	echo "Scanning ${#repos[@]} repo(s) for worktrees older than ${weeks}w..."

	# Candidate rows, one per removable worktree: "repo|branch|path|age_days|merge_label"
	local -a candidates
	local n_repos_ok=0 n_worktrees=0 n_young=0 n_dirty=0 n_pr=0 n_stale=0
	local repo gh_slug remote_url json rows branch wtpath ts main_state dirty wtstate age_days merge_label pr_info
	for repo in "${repos[@]}"; do
		[[ -d "$repo" ]] || continue

		gh_slug=""
		if $have_gh; then
			remote_url=$(git -C "$repo" remote get-url origin 2>/dev/null)
			[[ "$remote_url" =~ github\.com[:/]([^/]+/[^/.]+)(\.git)?$ ]] && gh_slug="${match[1]}"
		fi

		json=$(wt -C "$repo" --config-set list.json-schema=1 list --format json 2>/dev/null)
		if [[ -z "$json" ]]; then
			echo "warn  $(basename "$repo"): 'wt list' failed, skipping this repo" >&2
			continue
		fi
		n_repos_ok=$((n_repos_ok + 1))

		# The JSON from `wt list` can carry stray ANSI escapes in the
		# statusline field when captured via command substitution; strip
		# them defensively so jq never chokes on a raw control character.
		# Age filtering happens below in the shell, not here, so young
		# worktrees can still be counted (and shown with --verbose).
		rows=$(printf '%s' "$json" | LC_ALL=C tr -d '\033' | jq -r '
			.[] | select(.is_main != true and .is_current != true) |
			[.branch, .path, .commit.timestamp, (.main_state // "unknown"),
			 ((.working_tree.staged // false) or (.working_tree.modified // false) or (.working_tree.untracked // false) or (.working_tree.deleted // false) or (.working_tree.renamed // false)),
			 (.worktree.state // "")] |
			@tsv
		')
		[[ -z "$rows" ]] && continue

		local repo_label="$(basename "$repo")"
		local -a repo_lines=()

		while IFS=$'\t' read -r branch wtpath ts main_state dirty wtstate; do
			[[ -z "$branch" ]] && continue
			n_worktrees=$((n_worktrees + 1))

			# A worktree whose directory is already gone (deleted outside wt,
			# a crashed tool, etc.) reports commit.timestamp=0 — computing an
			# age from that would print nonsense (tens of thousands of days).
			# There's nothing left to lose here, so it's always a candidate,
			# regardless of the age threshold.
			if [[ "$wtstate" == "prunable" ]]; then
				n_stale=$((n_stale + 1))
				repo_lines+=("  ${c_green}rm${c_reset}    stale  $branch  (worktree directory is gone; cleaning up the dangling reference)")
				candidates+=("$repo|$branch|$wtpath|stale|0")
				continue
			fi

			age_days=$(((now - ts) / 86400))

			case "$main_state" in
			empty | integrated) merge_label="merged → branch will be deleted" ;;
			ahead) merge_label="unmerged → branch will be kept" ;;
			*) merge_label="merge status unknown → branch will be kept" ;;
			esac
			$force_delete && [[ "$merge_label" == *kept ]] && merge_label="unmerged → -D will delete the branch too"

			if ((ts >= cutoff)); then
				n_young=$((n_young + 1))
				$verbose && repo_lines+=("  keep  ${age_days}d  $branch  (younger than ${weeks}w)")
				continue
			fi

			if [[ "$dirty" == "true" ]]; then
				n_dirty=$((n_dirty + 1))
				repo_lines+=("  ${c_yellow}skip${c_reset}  ${age_days}d  $branch  (uncommitted changes)")
				continue
			fi

			if [[ -n "$gh_slug" ]]; then
				pr_info=$(gh pr list --repo "$gh_slug" --head "$branch" --state open --json number,title -q '.[0] | select(. != null) | "#\(.number) \(.title)"' 2>/dev/null)
				if [[ -n "$pr_info" ]]; then
					n_pr=$((n_pr + 1))
					repo_lines+=("  ${c_yellow}skip${c_reset}  ${age_days}d  $branch  (open PR $pr_info)")
					continue
				fi
			fi

			local size_kb=0 size_human=""
			size_kb=$(du -sk "$wtpath" 2>/dev/null | cut -f1)
			[[ -z "$size_kb" ]] && size_kb=0
			size_human=$(_wtclean_human_kb "$size_kb")
			repo_lines+=("  ${c_green}rm${c_reset}    ${age_days}d  $branch  (${size_human} on disk, $merge_label)")
			candidates+=("$repo|$branch|$wtpath|$age_days|$size_kb")
		done <<<"$rows"

		if [[ ${#repo_lines[@]} -gt 0 ]]; then
			echo
			echo "$repo_label:"
			printf '%s\n' "${repo_lines[@]}"
		fi
	done

	echo
	local stale_note=""
	[[ $n_stale -gt 0 ]] && stale_note=", $n_stale stale (dangling) reference(s)"
	echo "Scanned $n_repos_ok repo(s), $n_worktrees worktree(s): ${#candidates[@]} removable, $n_dirty dirty, $n_pr with an open PR, $n_young under ${weeks}w old${stale_note}."

	if [[ ${#candidates[@]} -eq 0 ]]; then
		echo "Nothing to clean."
		return 0
	fi

	local total_kb=0 c _trepo _tbranch _tpath _tage _tsize
	for c in "${candidates[@]}"; do
		IFS='|' read -r _trepo _tbranch _tpath _tage _tsize <<<"$c"
		total_kb=$((total_kb + _tsize))
	done
	echo "Total reclaimable: $(_wtclean_human_kb "$total_kb") across ${#candidates[@]} worktree(s)."

	if $dry_run; then
		echo "Dry run — nothing removed."
		return 0
	fi

	if ! $auto_yes; then
		local confirm
		read "confirm?Remove ${#candidates[@]} worktree(s) above? [y/N]: "
		[[ "$confirm" == [yY] ]] || {
			echo "Cancelled."
			return 1
		}
	fi

	local n_removed=0 n_failed=0
	local -a failed_list
	local crepo cbranch cpath cage csize_kb
	for c in "${candidates[@]}"; do
		IFS='|' read -r crepo cbranch cpath cage csize_kb <<<"$c"
		local -a rm_args=(-y)
		$force_delete && rm_args+=(-D)
		if [[ "$cage" == "stale" ]]; then
			echo "Removing $cbranch @ $(basename "$crepo") (stale reference)..."
		else
			echo "Removing $cbranch @ $(basename "$crepo") ($(_wtclean_human_kb "$csize_kb"))..."
		fi
		if wt -C "$crepo" remove "$cbranch" "${rm_args[@]}" 2>&1; then
			n_removed=$((n_removed + 1))
		else
			n_failed=$((n_failed + 1))
			failed_list+=("$cbranch @ $(basename "$crepo")")
		fi
	done

	echo
	if [[ $n_failed -eq 0 ]]; then
		echo "Removed $n_removed worktree(s)."
	else
		echo "${c_red}Removed $n_removed worktree(s), $n_failed failed:${c_reset}"
		printf '  - %s\n' "${failed_list[@]}"
	fi
}
