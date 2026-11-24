#!/usr/bin/env bash
# Read-only health by default. Never edit package source or delete recovery backups.
set -euo pipefail
mem_dir="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}/pi-hermes-memory"
db="${mem_dir}/sessions.db"
checkpoint=false
approved=false
backup_dir=""
while (($#)); do
  case "$1" in
    --checkpoint) checkpoint=true ;;
    --approved) approved=true ;;
    --backup-dir) shift; backup_dir="${1:?--backup-dir needs a retained backup directory}" ;;
    --db) shift; db="${1:?--db needs a database path}" ;;
    --help) printf '%s\n' 'Usage: pi-memory-repair.sh [--db PATH] [--checkpoint --approved --backup-dir NEW_DIRECTORY]' 'Default: read-only SQLite integrity and counts. Retains all recovery artifacts.'; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
if [[ ! -f "$db" ]]; then printf 'No Hermes database at %s\n' "$db"; exit 0; fi
db=$(cd "$(dirname "$db")" && printf '%s/%s' "$(pwd -P)" "$(basename "$db")")
printf 'Hermes database: %s\n' "$db"
health=$(sqlite3 -readonly "$db" 'PRAGMA integrity_check;')
printf 'integrity_check: %s\n' "$health"
if [[ "$health" != ok ]]; then
  printf '%s\n' 'Integrity failed. Preserve the database and recovery artifacts. No automatic repair.' >&2
  exit 1
fi
sqlite3 -readonly "$db" 'SELECT COUNT(*) AS indexed_memories FROM memories;'
if "$checkpoint"; then
  if ! "$approved" || [[ -z "$backup_dir" ]]; then
    printf '%s\n' 'Checkpoint needs --approved and --backup-dir. Stop affected writers first.' >&2; exit 2
  fi
  # mkdir refuses reuse. SQLite backup captures a consistent snapshot including WAL.
  mkdir -m 700 "$backup_dir"
  backup_dir=$(cd "$backup_dir" && pwd -P)
  # Use a fixed filename from the retained directory, not SQLite dot-command quoting.
  (cd "$backup_dir" && sqlite3 -readonly "$db" '.backup sessions.db')
  [[ $(sqlite3 -readonly "$backup_dir/sessions.db" 'PRAGMA integrity_check;') == ok ]]
  result=$(sqlite3 "$db" 'PRAGMA busy_timeout=5000; PRAGMA wal_checkpoint(TRUNCATE);')
  printf 'checkpoint: %s\nRetained backup: %s\n' "$result" "$backup_dir/sessions.db"
  [[ "${result##*$'\n'}" == 0\|* ]] || { printf '%s\n' 'Checkpoint busy. Backup retained; retry only after writers stop.' >&2; exit 1; }
fi
printf '%s\n' 'Package code and recovery artifacts unchanged.'
