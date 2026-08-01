# Worktrunk (wt) helpers, unified behind a single `wtx` entrypoint.
#
# Global wt config lives in the `worktrunk` stow package
# (~/.config/worktrunk/config.toml): it symlinks .venv, copies gitignored
# files, opens a new VS Code window, and registers the repo into
# ~/.cache/wt/known-repos on `post-start` (i.e. whenever `wt switch --create`
# actually creates a worktree). Project-specific setup (e.g. tardis-community's
# per-pipeline `dbt deps`) lives in the same file under [projects."..."].
# This file only handles branch naming, cross-repo listing/cleanup, and
# single-worktree removal — it stays out of the way of those hooks so
# VS Code doesn't open twice.
#
# Usage: wtx SUBCOMMAND [ARGS...] — run `wtx help` for the full list.
# Subcommand names deliberately mirror wt's own vocabulary (list, remove)
# or the names this setup already used pre-wtx (new, clean), so there's
# nothing new to memorize on top of `wt --help`.

wtx() {
	local sub="$1"
	if [[ -z "$sub" || "$sub" == "-h" || "$sub" == "--help" ]]; then
		_wtx_usage
		return 0
	fi
	shift

	case "$sub" in
	new | n) _wtx_new "$@" ;;
	list | ls) _wtx_list "$@" ;;
	clean) _wtx_clean "$@" ;;
	remove | rm) _wtx_remove "$@" ;;
	status | st) _wtx_status "$@" ;;
	help) _wtx_usage ;;
	*)
		echo "Error: unknown subcommand '$sub'" >&2
		_wtx_usage >&2
		return 1
		;;
	esac
}

_wtx_usage() {
	cat <<'EOF'
Usage: wtx SUBCOMMAND [ARGS...]

Subcommands:
  new    [n]   [WT_SWITCH_OPTIONS...]         Prompt for a branch description, create/reuse a worktree
  list   [ls]  [--repo NAME] [--json]         List worktrees across every known repo (+ the current one)
  clean        [WEEKS] [flags]                Remove worktrees older than WEEKS (default 2), with safety checks
  remove [rm]  [BRANCH...] [--repo NAME] [..] Remove one or more worktrees (fzf picker if BRANCH omitted)
  status [st]                                 Show the code-review-graph daemon status + known-repo registry
  help                                        Show this help

Run 'wtx SUBCOMMAND --help' for subcommand-specific options.
EOF
}

# Print the set of repos wt has seen: everything in the known-repos registry
# (populated by the post-start `registry` hook, i.e. only repos wtx has
# actually created a worktree for) plus the repo you're currently standing
# in, if any — deduped, one absolute path per line. Shared by list/clean/remove
# so "which repos do we scan" stays defined in exactly one place.
_wtx_known_repos() {
	local -a repos
	local registry="$HOME/.cache/wt/known-repos"
	if [[ -f "$registry" ]]; then
		while IFS= read -r line; do
			[[ -n "$line" ]] && repos+=("$line")
		done <"$registry"
	fi

	# git-common-dir always resolves to the MAIN repo's .git, whether run from
	# the main checkout or any linked worktree — unlike --show-toplevel, which
	# would add the current worktree's own path as a second, differently-named
	# "repo" and cause every worktree of that repo to be scanned twice.
	local cwd_repo
	cwd_repo=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
	[[ -n "$cwd_repo" ]] && cwd_repo=$(dirname "$cwd_repo")
	if [[ -n "$cwd_repo" ]]; then
		local already=false r
		for r in "${repos[@]}"; do
			[[ "$r" == "$cwd_repo" ]] && already=true && break
		done
		$already || repos+=("$cwd_repo")
	fi

	printf '%s\n' "${repos[@]}"
}

# Best-effort filesystem birth time (creation time) of a path, as a Unix
# timestamp. Falls back with a non-zero exit if unavailable (e.g. a
# filesystem without birthtime support), so callers can fall back to
# something else (typically the last-commit timestamp).
_wtx_creation_ts() {
	local wtpath="$1" ts
	# BSD/macOS stat: %B = birth time, prints 0 if the filesystem doesn't track it.
	ts=$(stat -f '%B' "$wtpath" 2>/dev/null)
	if [[ -n "$ts" && "$ts" != "0" ]]; then
		print -r -- "$ts"
		return 0
	fi
	# GNU stat: %W = birth time, prints 0 or "-" if unsupported.
	ts=$(stat --format='%W' "$wtpath" 2>/dev/null)
	if [[ -n "$ts" && "$ts" != "0" && "$ts" != "-" ]]; then
		print -r -- "$ts"
		return 0
	fi
	return 1
}

# Format a KB integer (as from `du -sk`) as a short human-readable size.
_wtx_human_kb() {
	local kb=$1
	if ((kb >= 1048576)); then
		printf '%.1fG' $((kb / 1048576.0))
	elif ((kb >= 1024)); then
		printf '%.1fM' $((kb / 1024.0))
	else
		printf '%dK' "$kb"
	fi
}

# wtx new — prompt for a short branch description (or fall back to a
# timestamp id), then create or reuse a worktree for it via `wt switch`.
# Ticket/PR references are deliberately not part of this — attach those
# when opening the PR instead.
_wtx_new() {
	if [[ "$1" == "-h" || "$1" == "--help" ]]; then
		echo "Usage: wtx new [WT_SWITCH_OPTIONS...]"
		echo
		echo "Prompts for a short branch description and creates/reuses a git"
		echo "worktree for it via 'wt switch'. Leave it blank to fall back to a"
		echo "timestamp-based branch name (wip-YYYYMMDD-HHMMSS)."
		echo
		echo "Any extra arguments are forwarded to 'wt switch', e.g.:"
		echo "  wtx new --base develop"
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

	# Resolved via git-common-dir (not --show-toplevel) so this also works
	# correctly when wtx new is run from inside an existing worktree, not
	# just the main checkout. Computed unconditionally (not gated on jq)
	# since the reuse path below needs it too, regardless of jq presence.
	local repo_root
	repo_root=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
	[[ -n "$repo_root" ]] && repo_root=$(dirname "$repo_root")

	# Show what's already in flight for this repo before asking for a new
	# description — avoids accidentally starting a near-duplicate of work
	# that's already sitting in another worktree.
	if [[ -n "$repo_root" ]] && command -v jq &>/dev/null; then
		local existing
		existing=$(wt -C "$repo_root" --config-set list.json-schema=1 list --format json 2>/dev/null \
			| LC_ALL=C tr -d '\033' \
			| jq -r '.[] | select(.is_main != true and .is_current != true) | "  \(.branch)"' 2>/dev/null)
		if [[ -n "$existing" ]]; then
			echo "Existing worktrees for $(basename "$repo_root"):"
			echo "$existing"
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
		# post-start hooks (VS Code, venv, copy-ignored, herdr registration)
		# only fire on creation (per wt's own docs: "wt switch — Runs
		# pre-start/post-start hooks on --create") — reusing an existing
		# worktree skips them entirely. Replicate what's needed here: open
		# the editor ourselves, then re-run just the "herdr" post-start hook
		# (registers the repo + this worktree as herdr workspaces) so a
		# worktree that predates the herdr hook, or is being reused from a
		# fresh terminal, still shows up in herdr instead of silently never
		# getting registered.
		if wt switch "$branch" "$@"; then
			code -n .
			if [[ -n "$repo_root" ]]; then
				local wt_path
				wt_path=$(git -C "$repo_root" worktree list --porcelain 2>/dev/null | awk -v b="refs/heads/$branch" '
					$1 == "worktree" { p = substr($0, 10) }
					$1 == "branch" && $2 == b { print p }
				')
				[[ -n "$wt_path" ]] && wt -C "$wt_path" hook post-start herdr -y &>/dev/null
			fi
		fi
	else
		# Creation-time setup (VS Code, venv symlink, copy-ignored, repo
		# registration) is handled by the global post-start hooks in
		# worktrunk's config.
		wt switch --create "$branch" "$@"
	fi
}

# wtx list — show every worktree across all known repos (+ the one you're
# standing in), grouped by repo. Read-only, no GitHub/PR calls, so it's
# always fast — use `wtx clean --dry-run` when you specifically need
# merge/PR status before removing something.
_wtx_list() {
	if [[ "$1" == "-h" || "$1" == "--help" ]]; then
		echo "Usage: wtx list [--repo NAME] [--json]"
		echo
		echo "Lists every worktree across all known repos (~/.cache/wt/known-repos)"
		echo "plus the repo you're currently standing in, if any."
		echo
		echo "  --repo NAME   Only list the repo whose directory basename is NAME"
		echo "  --json        Emit raw JSON, one array of items per repo, tagged"
		echo "                with a 'repo' field, merged into a single array"
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

	local repo_filter="" json_out=false
	while [[ $# -gt 0 ]]; do
		case "$1" in
		--repo)
			shift
			repo_filter="$1"
			;;
		--json) json_out=true ;;
		*)
			echo "Error: unknown argument '$1'" >&2
			return 1
			;;
		esac
		shift
	done

	local -a repos
	repos=("${(@f)$(_wtx_known_repos)}")
	if [[ ${#repos[@]} -eq 0 ]]; then
		echo "No known repos. Run 'wtx new' at least once, or cd into a repo." >&2
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

	local c_dim="" c_green="" c_yellow="" c_reset=""
	if [[ -t 1 ]]; then
		c_dim=$'\e[2m'
		c_green=$'\e[32m'
		c_yellow=$'\e[33m'
		c_reset=$'\e[0m'
	fi

	local now=$(date +%s)
	local -a json_parts
	local repo json rows total=0
	# Declared once, outside the loop below: a bare `local name` re-executed
	# on every repo iteration (rather than once, up front) is a zsh footgun —
	# once these already hold a value from a prior iteration, re-declaring
	# them bare prints a "name=value" dump instead of quietly resetting.
	local branch wtpath ts is_main is_current dirty main_state wtstate age tags flags creation_ts
	for repo in "${repos[@]}"; do
		[[ -d "$repo" ]] || continue
		json=$(wt -C "$repo" --config-set list.json-schema=1 list --format json 2>/dev/null)
		if [[ -z "$json" ]]; then
			echo "warn  $(basename "$repo"): 'wt list' failed, skipping this repo" >&2
			continue
		fi
		json=$(printf '%s' "$json" | LC_ALL=C tr -d '\033')

		if $json_out; then
			json_parts+=("$(printf '%s' "$json" | jq -c --arg repo "$(basename "$repo")" '[.[] | . + {repo: $repo}]')")
			continue
		fi

		rows=$(printf '%s' "$json" | jq -r '
			.[] | [.branch, .path, (.commit.timestamp // 0), (.is_main // false), (.is_current // false),
			       ((.working_tree.staged // false) or (.working_tree.modified // false) or (.working_tree.untracked // false) or (.working_tree.deleted // false) or (.working_tree.renamed // false)),
			       (.main_state // ""), (.worktree.state // "")] | @tsv
		')
		[[ -z "$rows" ]] && continue

		echo
		echo "$(basename "$repo"):"
		while IFS=$'\t' read -r branch wtpath ts is_main is_current dirty main_state wtstate; do
			[[ -z "$branch" ]] && continue
			total=$((total + 1))

			tags=""
			[[ "$is_main" == "true" ]] && tags="$tags ${c_dim}[main]${c_reset}"
			[[ "$is_current" == "true" ]] && tags="$tags ${c_green}[current]${c_reset}"

			flags=""
			[[ "$dirty" == "true" ]] && flags="$flags, dirty"
			case "$main_state" in
			empty | integrated) flags="$flags, merged" ;;
			esac

			if [[ "$wtstate" == "prunable" ]]; then
				age="stale"
				flags="$flags, ${c_yellow}worktree dir missing${c_reset}"
			else
				# For non-main worktrees, .commit.timestamp is the last-commit
				# date of the branch, which for a freshly created worktree with
				# no new commits is just the base branch's last commit — often
				# days/weeks old, not "how long has this worktree existed".
				# Prefer the worktree directory's filesystem birth time instead,
				# falling back to the commit timestamp when birthtime isn't
				# available (or for the main worktree, where commit age IS the
				# meaningful number: "repo last updated X days ago").
				if [[ "$is_main" != "true" ]] && creation_ts=$(_wtx_creation_ts "$wtpath"); then
					age="$(((now - creation_ts) / 86400))d"
				elif [[ "$ts" == "0" ]]; then
					age="?"
				else
					age="$(((now - ts) / 86400))d"
				fi
			fi
			flags="${flags#, }"
			[[ -n "$flags" ]] && flags=" ($flags)"

			echo "  $branch  $age$tags$flags"
		done <<<"$rows"
	done

	if $json_out; then
		printf '%s\n' "${json_parts[@]}" | jq -s 'add // []'
		return 0
	fi

	echo
	echo "Total: $total worktree(s) across ${#repos[@]} repo(s)."
}

# wtx clean — remove worktrees whose last commit is older than a given age,
# across every repo wtx has seen (~/.cache/wt/known-repos, populated by the
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
_wtx_clean() {
	if [[ "$1" == "-h" || "$1" == "--help" ]]; then
		echo "Usage: wtx clean [WEEKS] [-y|--yes] [-n|--dry-run] [-D|--force-delete] [-v|--verbose] [--repo NAME]"
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

	local -a repos
	repos=("${(@f)$(_wtx_known_repos)}")

	if [[ ${#repos[@]} -eq 0 ]]; then
		echo "No known repos to clean. Run 'wtx new' at least once, or cd into a repo." >&2
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
			size_human=$(_wtx_human_kb "$size_kb")
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
	echo "Total reclaimable: $(_wtx_human_kb "$total_kb") across ${#candidates[@]} worktree(s)."

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
			echo "Removing $cbranch @ $(basename "$crepo") ($(_wtx_human_kb "$csize_kb"))..."
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

# wtx remove — remove one or more specific worktrees by branch name. Unlike
# `wtx clean` (bulk, age-driven, unattended-friendly), this is the precise,
# interactive tool: no age threshold, no PR check — just "remove this one
# worktree", with an fzf picker when you don't already know the branch name.
#
# Scope resolution:
#   --repo NAME   -> only that repo
#   (default)     -> the repo you're standing in, if any; otherwise every
#                     known repo (~/.cache/wt/known-repos)
# Protected branches (main/master/live) are refused by wt's own pre-remove
# hook regardless of scope.
_wtx_remove() {
	if [[ "$1" == "-h" || "$1" == "--help" ]]; then
		echo "Usage: wtx remove [BRANCH...] [--repo NAME] [-y|--yes] [-f|--force] [-D|--force-delete]"
		echo
		echo "Removes one or more worktrees by branch name. If no BRANCH is given,"
		echo "opens an fzf picker (multi-select with Tab) scoped to --repo, or the"
		echo "repo you're standing in, or every known repo if neither applies."
		echo
		echo "  --repo NAME         Scope to the repo whose directory basename is NAME"
		echo "  -y, --yes           Skip wt's own confirmation prompt"
		echo "  -f, --force         Remove even if the worktree has uncommitted changes"
		echo "  -D, --force-delete  Also delete the branch even if unmerged"
		echo
		echo "A branch name that exists in more than one known repo is ambiguous and"
		echo "requires --repo to disambiguate."
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

	local repo_filter="" auto_yes=false force=false force_delete=false
	local -a branches
	while [[ $# -gt 0 ]]; do
		case "$1" in
		-y | --yes) auto_yes=true ;;
		-f | --force) force=true ;;
		-D | --force-delete) force_delete=true ;;
		--repo)
			shift
			repo_filter="$1"
			;;
		-*)
			echo "Error: unknown flag '$1'" >&2
			return 1
			;;
		*) branches+=("$1") ;;
		esac
		shift
	done

	local -a known
	known=("${(@f)$(_wtx_known_repos)}")
	if [[ ${#known[@]} -eq 0 ]]; then
		echo "No known repos. Run 'wtx new' at least once, or cd into a repo." >&2
		return 1
	fi

	# Determine scope repos + how it was derived, so a branch that isn't
	# found in an implicit (cwd-derived) scope can suggest --repo instead of
	# just failing silently.
	local -a scope
	local scope_kind="all"
	if [[ -n "$repo_filter" ]]; then
		scope_kind="repo-flag"
		local fr
		for fr in "${known[@]}"; do
			[[ "$(basename "$fr")" == "$repo_filter" ]] && scope+=("$fr")
		done
		if [[ ${#scope[@]} -eq 0 ]]; then
			echo "Error: no known repo named '$repo_filter'. Known repos:" >&2
			for fr in "${known[@]}"; do echo "  $(basename "$fr")" >&2; done
			return 1
		fi
	else
		local cwd_repo
		cwd_repo=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
		[[ -n "$cwd_repo" ]] && cwd_repo=$(dirname "$cwd_repo")
		if [[ -n "$cwd_repo" ]]; then
			scope_kind="cwd"
			scope=("$cwd_repo")
		else
			scope=("${known[@]}")
		fi
	fi

	# Gather removable (non-main, non-current) worktrees across every known
	# repo once, then filter to `scope` — the unfiltered set lets a "branch
	# not found in scope" error suggest where it actually lives.
	local -a all_entries
	local repo json rows b ts dirty
	for repo in "${known[@]}"; do
		[[ -d "$repo" ]] || continue
		json=$(wt -C "$repo" --config-set list.json-schema=1 list --format json 2>/dev/null)
		[[ -z "$json" ]] && continue
		rows=$(printf '%s' "$json" | LC_ALL=C tr -d '\033' | jq -r '
			.[] | select(.is_main != true and .is_current != true) |
			[.branch, (.commit.timestamp // 0),
			 ((.working_tree.staged // false) or (.working_tree.modified // false) or (.working_tree.untracked // false) or (.working_tree.deleted // false) or (.working_tree.renamed // false))] |
			@tsv
		')
		[[ -z "$rows" ]] && continue
		while IFS=$'\t' read -r b ts dirty; do
			[[ -z "$b" ]] && continue
			all_entries+=("$repo|$b|$ts|$dirty")
		done <<<"$rows"
	done

	local -a entries
	local e er repo_in_scope
	for e in "${all_entries[@]}"; do
		er="${e%%|*}"
		repo_in_scope=false
		for repo in "${scope[@]}"; do
			[[ "$er" == "$repo" ]] && repo_in_scope=true && break
		done
		$repo_in_scope && entries+=("$e")
	done

	if [[ ${#branches[@]} -eq 0 ]]; then
		if [[ ${#entries[@]} -eq 0 ]]; then
			echo "No removable worktrees in scope." >&2
			return 1
		fi
		if ! command -v fzf &>/dev/null; then
			echo "No BRANCH given and fzf isn't installed. Candidates in scope:" >&2
			for e in "${entries[@]}"; do
				IFS='|' read -r er b ts dirty <<<"$e"
				echo "  $b  @ $(basename "$er")$([[ "$dirty" == true ]] && echo ' (dirty)')" >&2
			done
			echo "Re-run: wtx remove BRANCH [--repo NAME]" >&2
			return 1
		fi

		local now=$(date +%s) age
		local -a menu picked_lines
		for e in "${entries[@]}"; do
			IFS='|' read -r er b ts dirty <<<"$e"
			age=$(((now - ts) / 86400))
			menu+=("$b  @ $(basename "$er")  (${age}d$([[ "$dirty" == true ]] && echo ', dirty'))|$e")
		done

		picked_lines=("${(@f)$(printf '%s\n' "${menu[@]}" | cut -d'|' -f1 | fzf --prompt='Remove worktree(s)> ' --height='~50%' --multi)}")
		if [[ ${#picked_lines[@]} -eq 0 || -z "${picked_lines[1]}" ]]; then
			echo "Cancelled."
			return 1
		fi

		local pl m
		for pl in "${picked_lines[@]}"; do
			for m in "${menu[@]}"; do
				if [[ "${m%%|*}" == "$pl" ]]; then
					IFS='|' read -r _ b _ _ <<<"${m#*|}"
					branches+=("$b")
					break
				fi
			done
		done
	fi

	local n_removed=0 n_failed=0
	local -a failed_list
	local branch
	# matches/elsewhere/m are declared once here, not re-declared bare inside
	# the loop below — see the _wtx_list comment above for why that matters.
	# matches/elsewhere are explicitly reset ("=()") each time they're
	# (re)populated, since a bare "local -a name" re-declare silently keeps
	# the previous iteration's contents instead of clearing it.
	local -a matches elsewhere
	local m
	for branch in "${branches[@]}"; do
		matches=()
		for e in "${entries[@]}"; do
			IFS='|' read -r er b _ _ <<<"$e"
			[[ "$b" == "$branch" ]] && matches+=("$er")
		done

		if [[ ${#matches[@]} -eq 0 ]]; then
			# Not in scope — check the unfiltered set for a helpful hint.
			elsewhere=()
			for e in "${all_entries[@]}"; do
				IFS='|' read -r er b _ _ <<<"$e"
				[[ "$b" == "$branch" ]] && elsewhere+=("$er")
			done
			if [[ ${#elsewhere[@]} -gt 0 && "$scope_kind" == "cwd" ]]; then
				echo "Error: no worktree for branch '$branch' in the current repo. Found it in:" >&2
				for m in "${elsewhere[@]}"; do echo "  $(basename "$m")  (re-run with --repo $(basename "$m"))" >&2; done
			else
				echo "Error: no worktree for branch '$branch' found in scope." >&2
			fi
			n_failed=$((n_failed + 1))
			failed_list+=("$branch (not found)")
			continue
		elif [[ ${#matches[@]} -gt 1 ]]; then
			echo "Error: branch '$branch' exists in multiple repos, disambiguate with --repo:" >&2
			for m in "${matches[@]}"; do echo "  $(basename "$m")" >&2; done
			n_failed=$((n_failed + 1))
			failed_list+=("$branch (ambiguous)")
			continue
		fi

		local target_repo="${matches[1]}"
		local -a rm_args=()
		$auto_yes && rm_args+=(-y)
		$force && rm_args+=(-f)
		$force_delete && rm_args+=(-D)

		echo "Removing '$branch' @ $(basename "$target_repo")..."
		if wt -C "$target_repo" remove "$branch" "${rm_args[@]}"; then
			n_removed=$((n_removed + 1))
		else
			n_failed=$((n_failed + 1))
			failed_list+=("$branch @ $(basename "$target_repo")")
		fi
	done

	if [[ ${#branches[@]} -gt 1 || $n_failed -gt 0 ]]; then
		echo
		if [[ $n_failed -eq 0 ]]; then
			echo "Removed $n_removed worktree(s)."
		else
			echo "Removed $n_removed worktree(s), $n_failed failed:"
			printf '  - %s\n' "${failed_list[@]}"
		fi
	fi

	((n_failed == 0))
}

# wtx status — quick health check for the surrounding tooling: the
# code-review-graph daemon (every watched repo/worktree + PIDs) and the
# known-repos registry that list/clean/remove all scan.
_wtx_status() {
	if [[ "$1" == "-h" || "$1" == "--help" ]]; then
		echo "Usage: wtx status"
		echo
		echo "Shows the code-review-graph daemon status and the known-repos"
		echo "registry (~/.cache/wt/known-repos) that 'wtx list/clean/remove' scan."
		return 0
	fi

	if command -v crg-daemon &>/dev/null; then
		crg-daemon status
	else
		echo "code-review-graph daemon not installed (crg-daemon not found)."
	fi

	echo
	local registry="$HOME/.cache/wt/known-repos"
	if [[ -f "$registry" ]]; then
		echo "Known repos ($registry):"
		sed 's/^/  /' "$registry"
	else
		echo "No known-repos registry yet — run 'wtx new' at least once."
	fi
}
