#!/usr/bin/env bash
# Stage specific paths, commit, and push in one call with minimal output.
# Usage: git-commit-push.sh "<commit message>" <path> [<path> ...]
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: git-commit-push.sh <message> <path>..." >&2
  exit 1
fi

msg="$1"
shift

git add -A -- "$@"

if git diff --cached --quiet; then
  echo "nothing staged for: $*" >&2
  exit 1
fi

stat=$(git diff --cached --stat | tail -1 | sed 's/^ *//')
git commit -q -m "$msg"
sha=$(git rev-parse --short HEAD)
git push -q

echo "$sha $msg | $stat"
