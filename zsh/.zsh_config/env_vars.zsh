# Editor and Environment Settings
export EDITOR="code"

# Kubernetes Configuration
export KUBECONFIG="$HOME/.kube/config:$HOME/.kube/eksconfig"

# TODO: Ensure this is not required anymore
# # Vault Configuration
# export VAULT_ADDR="https://vault.secrets.hellofresh.io"
# if [[ -s ~/.vault-token ]]; then
#     export VAULT_TOKEN=$(<~/.vault-token)
# else
#     echo "Vault token file does not exist or is empty."
# fi

# # Databricks Configuration
# if [[ -s ~/.databrickscfg ]]; then
#     export DATABRICKS_HOST=$(grep '^host' ~/.databrickscfg | cut -d = -f 2 | tr -d ' ')
#     export DATABRICKS_TOKEN=$(grep '^token' ~/.databrickscfg | cut -d = -f 2 | tr -d ' ')
# else
#     echo ".databrickscfg file does not exist or is empty."
# fi

# if [[ -s ~/.databricks-http ]]; then
#     export DATABRICKS_PATH=$(<~/.databricks-http)
# else
#     echo "Databricks HTTP file does not exist or is empty."
# fi

# if [[ -s ~/.databrickscfg-opsdap ]]; then
#     export DATABRICKS_OPSDAP_HOST=$(grep '^host' ~/.databrickscfg-opsdap | cut -d = -f 2 | tr -d ' ')
#     export DATABRICKS_OPSDAP_TOKEN=$(grep '^token' ~/.databrickscfg-opsdap | cut -d = -f 2 | tr -d ' ')
#     export DATABRICKS_OPSDAP_PATH=$(grep '^http_path' ~/.databrickscfg-opsdap | cut -d = -f 2 | tr -d ' ')
# else
#     echo ".databrickscfg-opsdap file does not exist or is empty."
# fi

# SQL Formatter Configuration
export SQLFMT_LINE_LENGTH=120

# Pylint Configuration
export PYLINTRC=~/.pylintrc

# Pip Configuration
export PIP_CONFIG_FILE=~/.config/pip/pip.conf

# Tardis
export SF_ACCOUNT="oo69432.eu-west-1"
export SF_USER='luis.aceituno@hellofresh.com'

# GitHub Token Configuration ()
# if [[ -s ~/.github-tokens ]]; then
#   export GITHUB_TOKEN_TARDIS=$(grep '^tardis' ~/.github-tokens | cut -d '=' -f 2 | tr -d ' ')
#   if [[ -z "$GITHUB_TOKEN" ]]; then
#     export GITHUB_TOKEN=$(head -n 1 ~/.github-tokens | cut -d '=' -f 2 | tr -d ' ')
#   fi
# else
#   echo ".github-tokens file does not exist or is empty."
# fi
