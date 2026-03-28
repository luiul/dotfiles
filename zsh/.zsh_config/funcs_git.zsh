# Git Functions

gignorelocal() {
	git status >/dev/null 2>&1
	if [ $? -eq 0 ]; then
		mkdir -p $(git rev-parse --show-toplevel)/.git/info
		${EDITOR:-vi} $(git rev-parse --show-toplevel)/.git/info/exclude
	else
		echo "Not a git project."
	fi
}

gignoreglobal() {
	git --version >/dev/null 2>&1
	if [ $? -eq 0 ]; then
		git config --global core.excludesfile >/dev/null 2>&1
		if [ $? -ne 0 ]; then
			git config --global core.excludesfile ~/.gitignore_global
			echo "Global gitignore file set to ~/.gitignore_global"
		fi
		${EDITOR:-vi} $(git config --global core.excludesfile)
	else
		echo "Git is not installed or not available."
	fi
}

gdeletemerged() {
	local dry_run=false
	local delete_remote=false
	local force_delete=false

	for arg in "$@"; do
		case $arg in
		--dry-run)
			dry_run=true
			shift
			;;
		--remote)
			delete_remote=true
			shift
			;;
		--force)
			force_delete=true
			shift
			;;
		*)
			echo "Usage: gdeletemerged [--dry-run] [--remote] [--force]"
			return 1
			;;
		esac
	done

	RED=$(tput setaf 1)
	GREEN=$(tput setaf 2)
	YELLOW=$(tput setaf 3)
	CYAN=$(tput setaf 6)
	RESET=$(tput sgr0)

	if ! command -v gh >/dev/null 2>&1; then
		echo "${RED}GitHub CLI (gh) not found.${RESET}"
		return 1
	fi

	echo "${CYAN}Fetching merged PRs from GitHub...${RESET}"

	merged_pr_branches=$(gh pr list --state merged --base main --json headRefName --jq '.[].headRefName')

	if [ -z "$merged_pr_branches" ]; then
		merged_pr_branches=$(gh pr list --state merged --base master --json headRefName --jq '.[].headRefName')
	fi

	if [ -z "$merged_pr_branches" ]; then
		echo "${YELLOW}No merged PRs found into main or master.${RESET}"
		return 0
	fi

	echo "${GREEN}Found merged PRs. Checking local branches...${RESET}"

	local deleted_branches=()
	local skipped_branches=()

	for local_branch in $(git for-each-ref --format='%(refname:short)' refs/heads/); do
		if [[ "$local_branch" == "main" || "$local_branch" == "master" ]]; then
			continue
		fi

		if echo "$merged_pr_branches" | grep -qx "$local_branch"; then
			echo "${YELLOW}Found merged branch: $local_branch${RESET}"

			if [ "$dry_run" = true ]; then
				echo "   ${CYAN}Would delete: $local_branch${RESET}"
				continue
			fi

			git branch -d "$local_branch" 2>/dev/null
			if [ $? -ne 0 ]; then
				if [ "$force_delete" = true ]; then
					echo "   ${RED}Normal delete failed. Forcing with -D...${RESET}"
					git branch -D "$local_branch"
					deleted_branches+=("$local_branch")
				else
					echo -n "   ${RED}Delete failed. Force delete with -D? (y/n): ${RESET}"
					read confirm_force
					if [[ "$confirm_force" == "y" ]]; then
						git branch -D "$local_branch"
						deleted_branches+=("$local_branch")
					else
						skipped_branches+=("$local_branch")
						echo "   ${YELLOW}Skipped: $local_branch${RESET}"
					fi
				fi
			else
				deleted_branches+=("$local_branch")
			fi

			if [ "$delete_remote" = true ]; then
				echo "   ${CYAN}Deleting remote branch: origin/$local_branch${RESET}"
				git push origin --delete "$local_branch" 2>/dev/null
			fi
		fi
	done

	echo
	echo "${CYAN}Cleanup Summary:${RESET}"
	echo "${GREEN}Deleted: ${#deleted_branches[@]}${RESET}"
	for b in "${deleted_branches[@]}"; do
		echo "  $b"
	done

	if [ ${#skipped_branches[@]} -gt 0 ]; then
		echo "${YELLOW}Skipped: ${#skipped_branches[@]}${RESET}"
		for b in "${skipped_branches[@]}"; do
			echo "  $b"
		done
	fi

	echo "${CYAN}Done.${RESET}"
}

grestorefile() {
	if [[ $# -lt 2 ]]; then
		echo "Usage: grestorefile <commit> <file-path>"
		return 1
	fi

	local commit=$1
	local file_path=$2

	git restore --source="$commit" --staged --worktree "$file_path"
}

delete-git-artifacts() {
	echo "WARNING: This will permanently delete the .git directory and all .git* files from the current directory and its subdirectories."
	echo -n "Are you sure you want to proceed? (y/N): "
	read -r confirm

	if [[ "$confirm" == "y" || "$confirm" == "Y" ]]; then
		echo "Removing .git directory..."
		rm -rf .git

		echo "Removing all .git* files and directories..."
		find . -name ".git*" -exec rm -rf {} +

		echo "Git artifacts cleanup completed."
	else
		echo "Operation canceled."
	fi
}

gcleanbranches() {
	local all_branches=$(git branch | sed 's/^\* //;s/^ *//;s/ *$//')

	echo "Available branches:"
	echo "-------------------"
	echo "$all_branches" | sed 's/^/  - /'
	echo

	echo "Enter the branches to keep (space-separated), or press Enter to cancel:"
	read -r keep_branches

	if [ -z "$keep_branches" ]; then
		echo "Operation cancelled. No branches deleted."
		return 0
	fi

	local keep_array=(${keep_branches})

	local branches_to_delete=$(echo "$all_branches" | while read -r branch; do
		if [[ ! " ${keep_array[@]} " =~ " ${branch} " ]]; then
			echo "$branch"
		fi
	done)

	if [ -z "$branches_to_delete" ]; then
		echo "No branches to delete."
		return 0
	fi

	echo
	echo "Branches to be deleted:"
	echo "-----------------------"
	echo "$branches_to_delete" | sed 's/^/  - /'
	echo

	echo "Are you sure you want to delete these branches? (y/N):"
	read -r confirm
	if [[ "$confirm" =~ ^[Yy]$ ]]; then
		echo "$branches_to_delete" | xargs git branch -D
		echo "Deleted branches."
	else
		echo "Operation cancelled. No branches deleted."
	fi
}

gupdatebranch() {
	if [ -z "$1" ]; then
		echo "Usage: gupdatebranch <branch-name>"
		return 1
	fi

	current_branch=$(git symbolic-ref --short HEAD)

	if [ "$current_branch" = "$1" ]; then
		echo "You are currently on '$1'. Cannot update a checked-out branch."
		return 1
	fi

	git fetch origin "$1:$1" && echo "Local '$1' updated from origin"
}

gwhichremote() {
	branch=${1:-$(git symbolic-ref --short HEAD)}
	git for-each-ref --format='%(upstream:short)' refs/heads/"$branch"
}

runprecommit() {
	timestamp() {
		date '+%H:%M:%S'
	}

	show_help() {
		cat <<EOF
Usage: runprecommit [options]

Run pre-commit hooks on the diff between two Git refs.

Options:
  --from <ref>      Git ref to diff from (default: origin/master)
  --to <ref>        Git ref to diff to (default: HEAD)
  --verbose         Show verbose output during pre-commit execution
  --help            Show this help message and exit

Examples:
  runprecommit --from main --to HEAD
  runprecommit --verbose
  runprecommit --help
EOF
	}

	local from_ref="origin/master"
	local to_ref="HEAD"
	local verbose=false

	while [[ $# -gt 0 ]]; do
		case "$1" in
		--from)
			from_ref="$2"
			shift 2
			;;
		--to)
			to_ref="$2"
			shift 2
			;;
		--verbose)
			verbose=true
			shift
			;;
		--help)
			show_help
			return 0
			;;
		*)
			echo "$(timestamp) Unknown option: $1"
			echo "Run 'runprecommit --help' for usage."
			return 1
			;;
		esac
	done

	echo "$(timestamp) Checking files changed between $from_ref and $to_ref"
	git diff --name-only "$from_ref"..."$to_ref"

	echo ""
	read "?$(timestamp) Run pre-commit on these files? (y/n) " confirm

	if [[ "$confirm" == "y" || "$confirm" == "Y" ]]; then
		echo "$(timestamp) Running pre-commit hooks..."
		if $verbose; then
			pre-commit run --from-ref "$from_ref" --to-ref "$to_ref" --verbose
		else
			pre-commit run --from-ref "$from_ref" --to-ref "$to_ref"
		fi
	else
		echo "$(timestamp) Skipping pre-commit run"
	fi
}

gpullall() {
	local reset_diverged_branches_without_prompt=false

	case "${1:-}" in
	--reset | -r)
		reset_diverged_branches_without_prompt=true
		;;
	"") ;;
	*)
		echo "Usage: gpullall [--reset|-r]"
		return 1
		;;
	esac

	for dir in */; do
		[ -d "$dir/.git" ] || continue

		echo "Updating repo: $dir"

		(
			cd "$dir" || exit 1

			if ! git fetch --prune; then
				echo "Fetch failed: $dir"
				exit 1
			fi

			current_branch_name="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
			upstream_branch_name="$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)"

			if [ -z "$upstream_branch_name" ]; then
				echo "No upstream configured for '$current_branch_name' in $dir — skipping"
				exit 0
			fi

			if git pull --ff-only --recurse-submodules; then
				git submodule update --init --recursive
				echo "Updated: $dir"
				exit 0
			fi

			echo "Cannot fast-forward '$current_branch_name' in $dir."
			echo "    Local branch and '$upstream_branch_name' have diverged."

			should_reset_diverged_branch="$reset_diverged_branches_without_prompt"

			if [ "$should_reset_diverged_branch" != true ]; then
				printf "Reset local branch '%s' to '%s'? This will discard local commits and changes [y/N]: " \
					"$current_branch_name" "$upstream_branch_name"
				read -r reset_confirmation

				case "$reset_confirmation" in
				[yY] | [yY][eE][sS])
					should_reset_diverged_branch=true
					;;
				*)
					should_reset_diverged_branch=false
					;;
				esac
			fi

			if [ "$should_reset_diverged_branch" = true ]; then
				if git reset --hard "$upstream_branch_name" && git submodule update --init --recursive; then
					echo "Reset to remote: $dir"
				else
					echo "Reset failed: $dir"
				fi
			else
				echo "Skipped reset: $dir"
			fi
		)
	done
}

gac() {
	if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
		echo "Not inside a Git repository."
		return 1
	fi

	git add -A

	if [ -f ".pre-commit-config.yaml" ]; then
		echo "pre-commit detected."
	fi

	local msg="$1"

	if [[ -z "$msg" ]]; then
		echo "No commit message provided. Launching commit editor..."

		local editor
		editor="$(git config --get core.editor 2>/dev/null)"

		if [[ "$editor" =~ (^|[[:space:]])code(-insiders)?($|[[:space:]]) ]] && [[ "$editor" != *"--wait"* ]]; then
			GIT_EDITOR="code --wait" git commit
			return $?
		fi

		if [[ "$editor" =~ (^|[[:space:]])subl($|[[:space:]]) ]] && [[ "$editor" != *" -w"* ]] && [[ "$editor" != *" --wait"* ]]; then
			GIT_EDITOR="subl -n -w" git commit
			return $?
		fi

		git commit
		return $?
	fi

	local trimmed_msg
	trimmed_msg="$(awk '{$1=$1; print}' <<<"$msg")"

	if [[ -z "$trimmed_msg" ]]; then
		echo "Commit message cannot be empty after trimming."
		return 1
	fi

	if command -v pbcopy >/dev/null 2>&1; then
		printf '%s' "$trimmed_msg" | pbcopy
	fi

	git commit -m "$trimmed_msg"
}

gsquashmergehere() {
	if [[ "$1" == "--help" || "$1" == "-h" ]]; then
		echo ""
		echo "squash-merge-here"
		echo ""
		echo "Prompts for a source branch and squash merges it into the current branch."
		echo "Optionally creates a new branch and commits the squash with a conventional message."
		echo ""
		echo "Usage:"
		echo "  gsquashmergehere [source_branch]"
		echo ""
		echo "Workflow:"
		echo "  1. Source branch from arg or prompt"
		echo "  2. Updates source branch"
		echo "  3. Returns to target branch"
		echo "  4. Optionally creates/switches to a new branch"
		echo "  5. Squash merges source branch"
		echo "  6. Commits with: chore: squash merge '<source>' into '<target>'"
		echo ""
		return 0
	fi

	local target_branch
	target_branch=$(git symbolic-ref --short HEAD) || return 1

	echo "You are currently on: '$target_branch'"

	echo ""
	echo "Available local branches:"
	git branch --format="  - %(refname:short)" | grep -v "^\*" || true

	local source_branch="${1:-}"
	if [[ -z "$source_branch" ]]; then
		echo ""
		echo -n "Enter the source branch to squash merge from: "
		read source_branch
	fi

	if [[ -z "$source_branch" ]]; then
		echo "Source branch is required."
		return 1
	fi

	if [[ "$source_branch" == "$target_branch" ]]; then
		echo "Source and target branch cannot be the same."
		return 1
	fi

	echo "You're about to squash merge changes into '$target_branch' from '$source_branch'."
	echo -n "Proceed with this operation? (y/n): "
	read confirm
	if [[ "$confirm" != "y" ]]; then
		echo "Operation cancelled by user."
		return 1
	fi

	git fetch origin "$source_branch" || return 1
	git checkout "$source_branch" && git pull origin "$source_branch" || return 1
	git checkout "$target_branch" || return 1

	local target_prefix="${target_branch%%/*}"
	local safe_source_branch="${source_branch//\//-}"

	local base_name="${target_branch}__into__${target_prefix}__from__${safe_source_branch}"
	echo -n "Enter new branch name (default: $base_name). Enter '$target_branch' to use current branch: "
	local new_branch
	read new_branch
	new_branch=${new_branch:-$base_name}

	if [[ "$new_branch" == "$target_branch" ]]; then
		echo "Using current branch: $target_branch (no new branch will be created)"
	else
		if git show-ref --verify --quiet "refs/heads/$new_branch"; then
			echo "Branch '$new_branch' already exists — switching to it"
			git checkout "$new_branch" || return 1
		else
			git checkout -b "$new_branch" || return 1
		fi
	fi

	git merge --squash "$source_branch" || return 1

	local commit_msg="chore: squash merge '$source_branch' into '$target_branch'"
	git commit -m "$commit_msg" || return 1

	echo "Squash merge complete on branch: $(git symbolic-ref --short HEAD)"
}

gbranch() {
	if [[ "$1" == "-h" || "$1" == "--help" ]]; then
		echo "Usage: gbranch [OPTIONS]"
		echo
		echo "Options:"
		echo "  -p, --push        Push the created branch to origin"
		echo "  -v, --verbose     Use verbose format: <type>/<parent>_<JIRA-TICKET>_<desc>"
		echo "  -h, --help        Show this help message"
		return 0
	fi

	local push_flag=false
	local verbose_flag=false

	while [[ "$1" != "" ]]; do
		case "$1" in
		-p | --push)
			push_flag=true
			;;
		-v | --verbose)
			verbose_flag=true
			;;
		*)
			echo "Error: Invalid option $1"
			return 1
			;;
		esac
		shift
	done

	function prompt_for_input() {
		local prompt_message="$1"
		local input_value=""
		while true; do
			read "input_value?$prompt_message"
			if [[ -z "$input_value" ]]; then
				echo "Input is required."
			else
				echo "$input_value"
				return 0
			fi
		done
	}

	function clean_string() {
		echo "$1" | tr '[:upper:]' '[:lower:]' | tr -s ' ' '-' | tr -cd '[:alnum:]-'
	}

	local valid_branch_types=("major" "minor" "patch" "issue" "hotfix" "feature" "release")
	local branch_type
	while true; do
		branch_type=$(prompt_for_input "Enter branch type (${valid_branch_types[*]}): ")
		if [[ " ${valid_branch_types[@]} " =~ " $branch_type " ]]; then
			break
		else
			echo "Invalid type. Use one of: ${valid_branch_types[*]}"
		fi
	done

	local jira_ticket
	while true; do
		jira_ticket=$(prompt_for_input "Enter Jira ticket (e.g., ISA-1234): ")
		if [[ "$jira_ticket" =~ ^[A-Z]+-[0-9]+$ ]]; then
			break
		else
			echo "Invalid format. Use format: ABC-123"
		fi
	done

	local description
	description=$(prompt_for_input "Enter task description: ")
	local clean_description=$(clean_string "$description")

	local clean_parent=""
	if $verbose_flag; then
		local parent_task
		parent_task=$(prompt_for_input "Enter parent task/project: ")
		clean_parent=$(clean_string "$parent_task")
	fi

	local branch_name=""
	if $verbose_flag; then
		branch_name="${branch_type}/${clean_parent}_${jira_ticket}_${clean_description}"
	else
		branch_name="${branch_type}/${jira_ticket}_${clean_description}"
	fi

	echo "Creating branch: $branch_name"
	git checkout -b "$branch_name"
	if [[ $? -ne 0 ]]; then
		echo "Git error: Failed to create branch."
		return 1
	fi

	if $push_flag; then
		echo "Pushing branch to origin..."
		git push origin "$branch_name"
		if [[ $? -ne 0 ]]; then
			echo "Git error: Failed to push branch."
			return 1
		fi
		echo "Branch created and pushed: $branch_name"
	else
		echo "Branch created: $branch_name"
	fi
}

gurl() {
	local remote="${1:-origin}"

	local url
	if ! url="$(git remote get-url "$remote" 2>/dev/null)"; then
		echo "gurl: couldn't get URL for remote '$remote' (are you in a git repo?)" >&2
		return 1
	fi

	local shown_url="$url"

	if [[ "$url" =~ '^git@([^:]+):(.+)$' ]]; then
		url="https://${match[1]}/${match[2]}"
	elif [[ "$url" =~ '^ssh://git@([^/]+)/(.+)$' ]]; then
		url="https://${match[1]}/${match[2]}"
	fi

	url="${url%.git}"

	echo "$shown_url"

	if command -v open >/dev/null 2>&1; then
		open "$url"
	elif command -v xdg-open >/dev/null 2>&1; then
		xdg-open "$url" >/dev/null 2>&1 &
	elif command -v wslview >/dev/null 2>&1; then
		wslview "$url" >/dev/null 2>&1 &
	else
		echo "gurl: couldn't find a way to open the browser" >&2
		return 2
	fi
}

gclone() {
	if [ "$#" -eq 0 ]; then
		echo "Usage: gclone <url1> [url2 ...]"
		return 1
	fi

	for repo in "$@"; do
		local repo_name
		repo_name=$(basename -s .git "$repo")

		if [ -d "$repo_name" ]; then
			echo "Skipping '$repo_name' — directory already exists."
			continue
		fi

		echo "Cloning $repo..."
		if git clone --recurse-submodules "$repo"; then
			echo "Successfully cloned '$repo_name'"
		else
			echo "Failed to clone '$repo_name'"
		fi
	done
}

gforcereset() {
	local branch remote_branch
	branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || {
		echo "Not inside a git repository."
		return 1
	}

	remote_branch="origin/$branch"

	echo "Current branch: $branch"
	echo "Will reset to:  $remote_branch"
	echo
	echo "This will permanently discard ALL local changes."
	read "?Are you sure? (yes/no): " confirm

	if [[ "$confirm" != "yes" ]]; then
		echo "Aborted."
		return 1
	fi

	echo "Fetching origin..."
	git fetch origin || return 1

	echo "Resetting branch to $remote_branch..."
	git reset --hard "$remote_branch" || return 1

	echo
	read "?Clean untracked files too? (yes/no): " do_clean
	if [[ "$do_clean" == "yes" ]]; then
		echo "Cleaning untracked files..."
		git clean -fd
	fi

	echo "Branch '$branch' is now fully reset to '$remote_branch'."
}
