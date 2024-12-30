# Environment Variables
alias dev='ENV=dev'
alias staging='ENV=staging'
alias live='ENV=live'

alias k=kubectl

# Basic Commands
alias ls="ls --color=auto"
alias la="ls -AthGl"
alias lg="la | grep -i --color" # List all files and filter them using grep="ls -lA | grep"  # List all files and filter them using grep
alias copy='pbcopy'

# File Management
alias rmf='rm -i'  # Interactive file removal
alias rmd='rm -ri' # Interactive directory removal

# AWS CLI
alias s3="aws s3" # Shortcut for AWS S3 command

# alias act_prod="activate && export ENVIRONMENT=production" # Activate virtual environment and set ENVIRONMENT
# alias act_stg="activate && export ENVIRONMENT=staging"     # Activate virtual environment and set ENVIRONMENT

alias pip-upgrade-all="pip freeze --local | grep -v '^\-e' | cut -d = -f 1  | xargs -n1 pip install -U" # Upgrade all pip packages
alias pip-uninstall-all="pip uninstall -y -r <(pip freeze)"
# alias pip-install-reqs="find . -name 'requirements.txt' -exec pip install -r {} \;"

# alias aws-sso-it="aws_sso sso-hf-it-developer"

# Misc
alias copydirs="ls -d */ | tr -d '/' | pbcopy"
alias countfiles="ls -1 | wc -l"
alias copywd="pwd | pbcopy"
