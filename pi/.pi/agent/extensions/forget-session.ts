/**
 * forget-session — a /command to make the current session ephemeral for
 * pi-hermes-memory.
 *
 * What it does when you run `/forget-session`:
 *   1. Blocks all further memory + skill writes made by THIS pi process for the
 *      rest of the session (the agent's own `memory` / `skill_manage` tool
 *      calls).
 *   2. Deletes anything this session already wrote: restores the memory
 *      markdown files (MEMORY.md, USER.md, project MEMORY.md, SKILL.md files)
 *      to their session-start snapshot, and removes this session's rows from
 *      the SQLite store (extended memories + session-search index).
 *
 * Note on subprocesses: pi-hermes-memory runs background review, correction
 * detection, and the shutdown/compact flush in child `pi -p` processes spawned
 * with `--no-extensions`, so this extension is NOT loaded there and cannot
 * block their writes directly. Instead those writes are undone by cleanup: at
 * the command and at session_shutdown, and — for fire-and-forget subprocesses
 * that land writes AFTER shutdown — at the start of the next session, which
 * restores the forgotten session's persisted snapshot before taking its own
 * baseline.
 *
 * It is NOT persistent. Nothing in the on-disk hermes config is changed; a
 * marker file is used only to remember that a session is being forgotten and
 * is cleared at the start of the next session, so new sessions revert to
 * default behavior.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);

// ─── Paths (respect hermes config overrides, fall back to defaults) ──────────
function agentRoot(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (configured) {
    const expanded = configured === "~"
      ? os.homedir()
      : configured.startsWith("~/")
        ? path.join(os.homedir(), configured.slice(2))
        : configured;
    return path.resolve(expanded);
  }
  return path.join(os.homedir(), ".pi", "agent");
}

function readHermesConfig(root: string): { memoryDir?: string; projectsMemoryDir?: string } {
  try {
    const raw = fs.readFileSync(path.join(root, "hermes-memory-config.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const ROOT = agentRoot();
const CFG = readHermesConfig(ROOT);

function expand(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

const MEMORY_DIR = CFG.memoryDir ? expand(CFG.memoryDir) : path.join(ROOT, "pi-hermes-memory");
const PROJECTS_DIR = path.join(ROOT, CFG.projectsMemoryDir?.trim() || "projects-memory");
const DB_PATH = path.join(MEMORY_DIR, "sessions.db");
const MARKER_PATH = path.join(MEMORY_DIR, ".forget-session.json");
const SNAPSHOT_PREFIX = ".forget-snapshot-";
const SNAPSHOT_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

const MEMORY_ROOTS = [MEMORY_DIR, PROJECTS_DIR];
const WRITE_TOOLS = new Set(["memory", "skill_manage"]);

// ─── File helpers ────────────────────────────────────────────────────────────
function isExcluded(file: string): boolean {
  const base = path.basename(file);
  return (
    base.startsWith("sessions.db") ||
    base === path.basename(MARKER_PATH) ||
    base.startsWith(SNAPSHOT_PREFIX) ||
    base.startsWith(".skills-migrated")
  );
}

function listFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(full, out);
    else if (e.isFile() && !isExcluded(full)) out.push(full);
  }
  return out;
}

// ─── SQLite helpers (node:sqlite, built into Node 22+) ───────────────────────
function withDb<T>(fn: (db: any) => T): T | undefined {
  if (!fs.existsSync(DB_PATH)) return undefined;
  let db: any;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA busy_timeout = 4000;");
    return fn(db);
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function getMaxMemoryId(): number | null {
  // Returns the current MAX(memories.id), or null if the DB is unavailable.
  // Distinguishing null (read failed) from 0 (empty table) is critical: the
  // `memories` table has no session column, so cleanup scopes deletes by an
  // `id > baseline` threshold. A transient read failure must NOT collapse the
  // baseline to 0, or cleanup would delete the entire memory store.
  const result = withDb((db) => {
    const row = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM memories").get();
    return Number(row?.m ?? 0);
  });
  return result === undefined ? null : result;
}

function dbCleanup(sessionId: string | null, maxMemoryId: number | null): void {
  withDb((db) => {
    // Only id-threshold-delete extended memories when we have a trusted
    // baseline. If the baseline read failed (null) we under-delete rather than
    // risk wiping unrelated memories.
    if (typeof maxMemoryId === "number") {
      db.prepare("DELETE FROM memories WHERE id > ?").run(maxMemoryId);
    }
    if (sessionId) {
      db.prepare("DELETE FROM session_files WHERE session_id = ?").run(sessionId);
      db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    }
  });
}

// ─── Marker (coordinates with child pi -p subprocesses) ──────────────────────
interface Marker { sessionId: string | null; pid: number; activatedAt: string }

function writeMarker(sessionId: string | null): void {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    const m: Marker = { sessionId, pid: process.pid, activatedAt: new Date().toISOString() };
    fs.writeFileSync(MARKER_PATH, JSON.stringify(m), "utf8");
  } catch { /* best effort */ }
}

function readMarker(): Marker | null {
  try {
    return JSON.parse(fs.readFileSync(MARKER_PATH, "utf8")) as Marker;
  } catch {
    return null;
  }
}

function removeMarker(): void {
  try { fs.rmSync(MARKER_PATH, { force: true }); } catch { /* ignore */ }
}

function markerExists(): boolean {
  try { return fs.existsSync(MARKER_PATH); } catch { return false; }
}

// ─── Persisted baseline snapshot (survives /reload, keyed by session id) ─────
interface Snapshot { sessionId: string; files: Record<string, string>; maxMemoryId: number | null }

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function snapshotPath(sessionId: string): string {
  return path.join(MEMORY_DIR, `${SNAPSHOT_PREFIX}${sanitize(sessionId)}.json`);
}

function saveSnapshot(snap: Snapshot): void {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(snapshotPath(snap.sessionId), JSON.stringify(snap), "utf8");
  } catch { /* best effort */ }
}

function loadSnapshot(sessionId: string): Snapshot | null {
  try {
    return JSON.parse(fs.readFileSync(snapshotPath(sessionId), "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

function removeSnapshot(sessionId: string | null): void {
  if (!sessionId) return;
  try { fs.rmSync(snapshotPath(sessionId), { force: true }); } catch { /* ignore */ }
}

function pruneStaleSnapshots(): void {
  try {
    for (const name of fs.readdirSync(MEMORY_DIR)) {
      if (!name.startsWith(SNAPSHOT_PREFIX)) continue;
      const full = path.join(MEMORY_DIR, name);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > SNAPSHOT_MAX_AGE_MS) {
          fs.rmSync(full, { force: true });
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ─── Extension ───────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  let forgetActive = false;
  let snapshot = new Map<string, string>();
  let snapshotMaxMemoryId: number | null = null;
  let sessionId: string | null = null;

  function currentSessionId(ctx: any): string | null {
    try {
      const sm = ctx?.sessionManager;
      // getSessionId() always returns the session UUID (even before the session
      // is persisted); getHeader().id is the same value and is what hermes keys
      // its rows by. Prefer getSessionId() so we never key on a null id.
      const id = sm?.getSessionId?.() ?? sm?.getHeader?.()?.id ?? null;
      return id || null;
    } catch {
      return null;
    }
  }

  function takeSnapshot(): void {
    // Capture the current state as this session's baseline, and persist it so
    // it survives /reload (which re-runs session_start). Without persistence,
    // a reload that happens after memories were written this session would
    // capture a dirty baseline and /forget-session could not undo those writes.
    snapshot = new Map();
    for (const root of MEMORY_ROOTS) {
      for (const file of listFiles(root)) {
        try { snapshot.set(file, fs.readFileSync(file, "utf8")); } catch { /* skip */ }
      }
    }
    snapshotMaxMemoryId = getMaxMemoryId();
    if (sessionId) {
      saveSnapshot({ sessionId, files: Object.fromEntries(snapshot), maxMemoryId: snapshotMaxMemoryId });
    }
  }

  function adoptSnapshot(snap: Snapshot): void {
    snapshot = new Map(Object.entries(snap.files));
    snapshotMaxMemoryId = snap.maxMemoryId;
  }

  function restoreFiles(): void {
    // Restore / re-create snapshotted files.
    for (const [file, content] of snapshot) {
      try {
        let current: string | null = null;
        try { current = fs.readFileSync(file, "utf8"); } catch { /* missing */ }
        if (current !== content) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, content, "utf8");
        }
      } catch { /* best effort */ }
    }
    // Delete files created during this session (not in snapshot).
    for (const root of MEMORY_ROOTS) {
      for (const file of listFiles(root)) {
        if (!snapshot.has(file)) {
          try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
        }
      }
      pruneEmptyDirs(root);
    }
  }

  function pruneEmptyDirs(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        const full = path.join(dir, e.name);
        pruneEmptyDirs(full);
        try {
          if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
        } catch { /* ignore */ }
      }
    }
  }

  function cleanup(): void {
    restoreFiles();
    dbCleanup(sessionId, snapshotMaxMemoryId);
  }

  // Block writes while forget is active in this process. Hermes subprocesses
  // run with --no-extensions so they never load this handler; their writes are
  // undone by cleanup (command, shutdown, and next-session leftover restore).
  pi.on("tool_call", async (event) => {
    if (!WRITE_TOOLS.has(event.toolName)) return;
    if (forgetActive || markerExists()) {
      return { block: true, reason: "Memory is disabled for this session (/forget-session)." };
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionId = currentSessionId(ctx);
    pruneStaleSnapshots();

    // Clean up a leftover marker from a previously forgotten session. Restore
    // that session's persisted snapshot first: fire-and-forget subprocesses
    // (shutdown/compact flush, background review) can land writes AFTER the
    // forgotten session's own cleanup ran, and this is the only place left to
    // undo them. Falls back to a best-effort db cleanup if no snapshot exists.
    const leftover = readMarker();
    if (leftover && leftover.sessionId !== sessionId) {
      const prevSnap = leftover.sessionId ? loadSnapshot(leftover.sessionId) : null;
      if (prevSnap) {
        snapshot = new Map(Object.entries(prevSnap.files));
        snapshotMaxMemoryId = prevSnap.maxMemoryId;
        restoreFiles();
        dbCleanup(leftover.sessionId, prevSnap.maxMemoryId);
      } else {
        dbCleanup(leftover.sessionId, getMaxMemoryId());
      }
      removeSnapshot(leftover.sessionId);
      removeMarker();
    }

    // Reuse the persisted baseline if this session already has one (i.e. this
    // is a /reload of an already-running session). Otherwise capture a fresh
    // baseline. This guarantees the baseline reflects the true start of the
    // session, not the moment of a mid-session reload.
    const existing = sessionId ? loadSnapshot(sessionId) : null;
    if (existing) adoptSnapshot(existing);
    else takeSnapshot();

    // Re-arm forget state across /reload (in-memory state is lost on reload,
    // but the marker on disk tells us this session is being forgotten).
    const marker = readMarker();
    if (marker && marker.sessionId === sessionId) forgetActive = true;
  });

  pi.registerCommand("forget-session", {
    description: "Make this session ephemeral: stop and delete all memory/skill writes from it (non-persistent).",
    handler: async (_args, ctx) => {
      forgetActive = true;
      sessionId = currentSessionId(ctx) ?? sessionId;
      writeMarker(sessionId);
      cleanup();
      ctx.ui.notify(
        "🔒 This session will not be remembered. Memory + skill writes are blocked and anything saved so far has been deleted. Default behavior returns next session.",
        "info",
      );
      ctx.ui.setStatus("forget-session", "memory: off (this session)");
    },
  });

  // On shutdown, re-run cleanup to remove anything written since the command.
  // The marker + persisted snapshot are intentionally left in place so the
  // fire-and-forget shutdown flush subprocess is blocked and a later /reload
  // still has the baseline; both are cleared at the next session_start.
  pi.on("session_shutdown", async () => {
    if (forgetActive) cleanup();
    else removeSnapshot(sessionId);
  });
}
