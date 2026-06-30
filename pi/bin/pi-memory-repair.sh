#!/usr/bin/env bash
# Repair / harden the pi-hermes-memory SQLite store.
#
# Why this exists: the pi-hermes-memory extension opens its shared sessions.db in
# WAL mode but does NOT set a busy_timeout. With more than one pi process running
# (common), concurrent writers race instead of waiting, which repeatedly corrupted
# the DB ("database disk image is malformed") and left a pile of .corrupt-* files.
#
# This script:
#   1. re-applies the busy_timeout + synchronous=NORMAL patch to the extension's
#      connection setup (node_modules is wiped on every `pi-hermes-memory` upgrade,
#      so re-run this after an upgrade);
#   2. checkpoints the WAL and runs an integrity check;
#   3. prunes stale .corrupt-* / .bak-* / forget-snapshot files.
#
# Safe to run anytime; idempotent. The markdown stores (MEMORY.md, USER.md,
# failures.md, projects-memory/*/MEMORY.md) are the source of truth and are never
# touched here.
set -euo pipefail

MEM_DIR="${HOME}/.pi/agent/pi-hermes-memory"
DB="${MEM_DIR}/sessions.db"
EXT_DB_TS="${HOME}/.pi/agent/npm/node_modules/pi-hermes-memory/src/store/db.ts"

echo "==> pi-hermes-memory repair"

# 1. Re-apply the pragma patch if missing.
if [[ -f "${EXT_DB_TS}" ]]; then
  if grep -q "PRAGMA busy_timeout" "${EXT_DB_TS}"; then
    echo "    extension pragma patch: already present"
  else
    # Insert busy_timeout + synchronous right after the journal_mode=WAL line.
    perl -0pi -e "s/(db\.exec\('PRAGMA journal_mode = WAL'\);\n)/\$1    db.exec('PRAGMA busy_timeout = 5000');\n    db.exec('PRAGMA synchronous = NORMAL');\n/" "${EXT_DB_TS}"
    if grep -q "PRAGMA busy_timeout" "${EXT_DB_TS}"; then
      echo "    extension pragma patch: RE-APPLIED (restart pi to take effect)"
    else
      echo "    extension pragma patch: FAILED to apply (file shape changed?) — patch manually" >&2
    fi
  fi
else
  echo "    extension not found at ${EXT_DB_TS} (skipping patch)"
fi

# 2. Checkpoint + integrity check (only if not locked by a running pi).
if [[ -f "${DB}" ]]; then
  echo "    integrity_check: $(sqlite3 "${DB}" 'PRAGMA integrity_check;' 2>&1 | head -1)"
  sqlite3 "${DB}" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1 || true
  echo "    memories indexed: $(sqlite3 "${DB}" 'SELECT COUNT(*) FROM memories;' 2>&1)"
fi

# 3. Prune stale corrupt/backup artifacts.
cd "${MEM_DIR}"
pruned=$(ls -1 sessions.db.corrupt-* sessions.db.bak-* .forget-snapshot-*.json 2>/dev/null | wc -l | tr -d ' ' || true)
rm -f sessions.db.corrupt-* sessions.db.bak-* .forget-snapshot-*.json 2>/dev/null || true
echo "    pruned stale files: ${pruned}"

echo "==> done"
