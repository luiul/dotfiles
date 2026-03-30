# Editor and Environment Settings
export EDITOR="code"

# Kubernetes Configuration
export KUBECONFIG="$HOME/.kube/config:$HOME/.kube/eksconfig"

# SQL Formatter Configuration
export SQLFMT_LINE_LENGTH=120

# Pip Configuration
export PIP_CONFIG_FILE=~/.config/pip/pip.conf

# AWS
export AWS_PROFILE="sso-bedrock"

# Anthropic / Claude CLI
export ANTHROPIC_DEFAULT_HAIKU_MODEL="eu.anthropic.claude-haiku-4-5-20251001-v1:0"
export ANTHROPIC_DEFAULT_SONNET_MODEL="eu.anthropic.claude-sonnet-4-6"
export ANTHROPIC_DEFAULT_OPUS_MODEL="eu.anthropic.claude-opus-4-6-v1"

# Zoxide
export _ZO_DOCTOR=0
