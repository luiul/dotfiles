dbtx() {
	local valid_envs=(dev staging live)
	local env subcommand
	local -a selectors extra_flags

	# Help
	if [[ "$1" == "--help" || "$1" == "-h" || $# -eq 0 ]]; then
		echo "Usage: dbtx <env> <subcommand> <models...> [flags...]"
		echo ""
		echo "Environments: ${valid_envs[*]}"
		echo ""
		echo "Examples:"
		echo "  dbtx live build base__supplier_sku__pricing+"
		echo "  dbtx live build base__supplier_sku__pricing+ --full-refresh"
		echo "  dbtx live test model_a+ model_b"
		echo "  dbtx live build all --full-refresh"
		echo "  dbtx dev run my_model"
		echo ""
		echo "Use 'all' to run without --select (targets everything)."
		return 0
	fi

	env="$1"
	shift

	# Validate env
	if [[ ! " ${valid_envs[*]} " == *" $env "* ]]; then
		echo "Error: Invalid environment '$env'. Must be one of: ${valid_envs[*]}" >&2
		return 1
	fi

	# Require subcommand
	if [[ $# -eq 0 ]]; then
		echo "Error: No subcommand specified (e.g. build, run, test)." >&2
		return 1
	fi

	subcommand="$1"
	shift

	# Split remaining args into selectors (no dash prefix) and flags (dash prefix)
	for arg in "$@"; do
		if [[ "$arg" == -* ]]; then
			extra_flags+=("$arg")
		else
			selectors+=("$arg")
		fi
	done

	# Require model selectors
	if [[ ${#selectors[@]} -eq 0 ]]; then
		echo "Error: No models specified. Pass model selectors or 'all' to run everything." >&2
		return 1
	fi

	# Build command
	local -a cmd=(dbt "$subcommand")

	if [[ ${#selectors[@]} -eq 1 && "${selectors[1]}" == "all" ]]; then
		: # no --select flag
	else
		cmd+=(--select "${selectors[@]}")
	fi

	cmd+=(--target "$env" "${extra_flags[@]}")

	# Print and run
	echo "+ ENV=$env ${cmd[*]}" >&2
	ENV="$env" "${cmd[@]}"
}
