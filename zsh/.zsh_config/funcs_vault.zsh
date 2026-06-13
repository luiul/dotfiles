# Log in to HelloFresh Vault via Azure SSO and export the client token
vault-login() {
	local namespace="${1:-services/isa-infrastructure}"

	export VAULT_ADDR='https://vault.secrets.hellofresh.io'

	# Authenticate using the OIDC (Azure SSO) method in the given namespace
	if ! VAULT_NAMESPACE="$namespace" vault login -method=oidc; then
		echo "Vault login failed for namespace: $namespace" >&2
		return 1
	fi

	# Replace any stale token with the freshly issued one
	unset VAULT_TOKEN
	export VAULT_TOKEN="$(vault print token)"

	if [[ -z "$VAULT_TOKEN" ]]; then
		echo "Failed to retrieve Vault token" >&2
		return 1
	fi

	local dim=$(tput dim)
	local bold=$(tput bold)
	local reset=$(tput sgr0)
	local green=$(tput setaf 2)

	echo ""
	echo "${green}${bold}logged in${reset} ${dim}${VAULT_ADDR}${reset}"
	echo "${dim}namespace ${reset}${bold}${namespace}${reset}"
	echo "${dim}token exported to ${reset}${bold}VAULT_TOKEN${reset}"
}
