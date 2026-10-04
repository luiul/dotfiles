# Lazy AWS SSO login.
#
# All profiles in ~/.aws/config share one [sso-session hfsso] block, so one
# `aws sso login` authorizes every profile. This validates the cached session
# first and only opens the browser flow when the token has actually expired.
#
# Usage: awslogin [profile]    (default: ${AWS_PROFILE:-sso-bedrock})
# The profile only selects which credentials to check; a login through any
# profile refreshes the shared session for all of them.
awslogin() {
	emulate -L zsh
	command -v aws &>/dev/null || { print -P "%F{red}✗%f aws CLI not found"; return 1 }

	local profile="${1:-${AWS_PROFILE:-sso-bedrock}}"
	local account
	if account=$(aws sts get-caller-identity --profile "$profile" --query Account --output text 2>/dev/null); then
		print -P "%F{green}✓%f AWS SSO session still valid (account $account) -- nothing to do"
		return 0
	fi

	print -P "%F{yellow}…%f AWS SSO session expired -- opening browser to log in ($profile)"
	if aws sso login --profile "$profile"; then
		print -P "%F{green}✓%f AWS SSO session refreshed -- all hfsso profiles authorized"
	else
		print -P "%F{red}✗%f aws sso login failed"
		return 1
	fi
}
