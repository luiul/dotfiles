#!/usr/bin/env bun
// Agent Radar watcher — dotfiles issue #11, phases 0-2 (read-only).
//
// Every poll cycle:
//   1. Scan the current user's processes for herdr's known agent kinds.
//   2. Resolve cwd + tty for each match.
//   3. Ask herdr which pids it already tracks (pane.process_info per pane).
//   4. Split matches into tracked (already visible in herdr's Agents
//      section) vs external (invisible to herdr today — the gap #11
//      describes).
//   5. Match each external agent's cwd to a herdr workspace using
//      git-worktree-aware repo identity, not plain string equality.
//   6. Write the full registry to disk for the "Agent Radar" pane.
//   7. Report a short-TTL workspace metadata badge for matched external
//      agents, and clear it immediately on a match -> no-match transition
//      instead of waiting for TTL expiry.
//
// This process is meant to run detached, started once by start-watcher.sh.
// It self-terminates if the plugin is disabled or unlinked, since herdr
// startup hooks are not supervised daemons (no stop hook exists to rely on).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";

const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";
const PLUGIN_ID = "luiul.agent-radar";
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || ".";
const POLL_MS = Number(process.env.AGENT_RADAR_POLL_MS || 7000);
const TTL_MS = Number(process.env.AGENT_RADAR_TTL_MS || POLL_MS * 3);
const MISS_LIMIT = 2; // consecutive misses before an entry is dropped
const DRY_RUN = process.env.AGENT_RADAR_DRY_RUN === "1"; // phase 1 only: skip report-metadata

const REGISTRY_PATH = path.join(STATE_DIR, "registry.json");
const BADGE_STATE_PATH = path.join(STATE_DIR, "badges.json");
const LOG_PATH = path.join(STATE_DIR, "watch.log");

// Known agent kinds herdr itself recognizes (`herdr agent start --help`).
const KNOWN_KINDS = new Set([
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp",
  "mastracode", "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok",
  "hermes", "kilo", "qodercli", "maki",
]);

// Second-token denylist: filters out subcommand/helper invocations that
// share a kind's executable name but are not the interactive agent itself
// (e.g. `codex mcp`, `claude --version`).
const SECOND_TOKEN_DENYLIST = new Set([
  "mcp", "mcp-server", "serve", "server", "--version", "-v", "-V", "--help", "-h",
]);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    writeFileSync(LOG_PATH, line, { flag: "a" });
  } catch {
    // best effort only
  }
}

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      ...opts,
    });
  } catch (err) {
    return null;
  }
}

function herdrJson(args) {
  const out = sh(HERDR_BIN, args);
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function currentUser() {
  return sh("id", ["-un"])?.trim() || process.env.USER || "";
}

// --- Phase 0/1: process scan + tracked/external split ------------------

function scanAgentProcesses(user) {
  const out = sh("ps", ["-u", user, "-o", "pid=,tty=,args="]);
  if (!out) return [];
  const matches = [];
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pidStr, tty, args] = m;
    if (tty === "??" || tty === "?") continue; // no controlling terminal: not an interactive agent
    const tokens = args.trim().split(/\s+/);
    const argv0 = tokens[0] || "";
    const kind = path.basename(argv0);
    if (!KNOWN_KINDS.has(kind)) continue;
    if (tokens[1] && SECOND_TOKEN_DENYLIST.has(tokens[1])) continue;
    matches.push({ pid: Number(pidStr), tty, kind, args });
  }
  return matches;
}

function resolveCwds(pids) {
  const cwdByPid = new Map();
  if (pids.length === 0) return cwdByPid;
  const out = sh("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"]);
  if (!out) return cwdByPid;
  let currentPid = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) currentPid = Number(line.slice(1));
    else if (line.startsWith("n") && currentPid !== null) {
      cwdByPid.set(currentPid, line.slice(1));
    }
  }
  return cwdByPid;
}

function herdrTrackedPids() {
  const tracked = new Set();
  const panes = herdrJson(["pane", "list"])?.result?.panes || [];
  for (const pane of panes) {
    const info = herdrJson(["pane", "process-info", "--pane", pane.pane_id])?.result?.process_info;
    if (!info) continue;
    if (info.shell_pid) tracked.add(info.shell_pid);
    for (const proc of info.foreground_processes || []) {
      if (proc.pid) tracked.add(proc.pid);
    }
  }
  return { tracked, panes };
}

// --- Phase 2a: git-worktree-aware repo identity for workspace matching --

function realpath(p) {
  return sh("realpath", [p])?.trim() || p;
}

function repoIdentity(dir) {
  const commonDir = sh("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"])?.trim();
  if (commonDir) return realpath(commonDir);
  // Older git without --path-format: resolve manually if it printed a relative path.
  const rawCommonDir = sh("git", ["-C", dir, "rev-parse", "--git-common-dir"])?.trim();
  if (rawCommonDir) {
    const abs = rawCommonDir.startsWith("/") ? rawCommonDir : path.resolve(dir, rawCommonDir);
    return realpath(abs);
  }
  return realpath(dir);
}

function buildWorkspaceIdentityMap(panes) {
  const map = new Map(); // identity -> Set(workspace_id)
  for (const pane of panes) {
    if (!pane.cwd || !pane.workspace_id) continue;
    const identity = repoIdentity(pane.cwd);
    if (!map.has(identity)) map.set(identity, new Set());
    map.get(identity).add(pane.workspace_id);
  }
  return map;
}

// --- Registry persistence with a 2-strike debounce ----------------------

function loadJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(p, data) {
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, p);
}

function key(entry) {
  return `${entry.pid}:${entry.kind}`;
}

function mergeRegistry(previousEntries, freshEntries) {
  const now = Date.now();
  const freshByKey = new Map(freshEntries.map((e) => [key(e), e]));
  const merged = new Map();

  for (const prev of previousEntries) {
    const k = key(prev);
    const fresh = freshByKey.get(k);
    if (fresh) {
      merged.set(k, { ...fresh, first_seen: prev.first_seen, misses: 0 });
      freshByKey.delete(k);
    } else {
      const misses = (prev.misses || 0) + 1;
      if (misses < MISS_LIMIT) {
        merged.set(k, { ...prev, misses, stale: true });
      }
      // else: drop, exceeded the debounce window
    }
  }

  for (const [k, fresh] of freshByKey) {
    merged.set(k, { ...fresh, first_seen: now, misses: 0 });
  }

  return [...merged.values()];
}

// --- Phase 2b: workspace metadata badges, with clear-on-transition ------

function reportBadges(matchedByWorkspace) {
  const previous = loadJson(BADGE_STATE_PATH, {});
  const current = {};

  for (const [workspaceId, kinds] of matchedByWorkspace) {
    const value = [...kinds].sort().join(",");
    current[workspaceId] = value;
    if (DRY_RUN) {
      log(`[dry-run] would report-metadata ${workspaceId} external_agent=${value}`);
      continue;
    }
    sh(HERDR_BIN, [
      "workspace", "report-metadata", workspaceId,
      "--source", PLUGIN_ID,
      "--token", `external_agent=${value}`,
      "--token", `external_agent_count=${kinds.size}`,
      "--ttl-ms", String(TTL_MS),
    ]);
  }

  for (const workspaceId of Object.keys(previous)) {
    if (!(workspaceId in current)) {
      if (DRY_RUN) {
        log(`[dry-run] would clear metadata on ${workspaceId}`);
        continue;
      }
      sh(HERDR_BIN, [
        "workspace", "report-metadata", workspaceId,
        "--source", PLUGIN_ID,
        "--clear-token", "external_agent",
        "--clear-token", "external_agent_count",
      ]);
    }
  }

  writeJsonAtomic(BADGE_STATE_PATH, current);
}

// --- Self-termination when disabled/unlinked ----------------------------

function stillEnabled() {
  const plugins = herdrJson(["plugin", "list", "--json"])?.result?.plugins;
  if (!Array.isArray(plugins)) return true; // fail open: don't self-kill on a transient CLI error
  const mine = plugins.find((p) => p.plugin_id === PLUGIN_ID);
  return !!mine && mine.enabled !== false;
}

// --- Main loop ------------------------------------------------------------

function pollOnce(user, previousEntries) {
  const scanned = scanAgentProcesses(user);
  const cwdByPid = resolveCwds(scanned.map((s) => s.pid));
  const { tracked, panes } = herdrTrackedPids();
  const identityMap = buildWorkspaceIdentityMap(panes);

  const fresh = scanned.map((s) => {
    const cwd = cwdByPid.get(s.pid) || null;
    const isTracked = tracked.has(s.pid);
    let workspaceIds = [];
    if (!isTracked && cwd) {
      const identity = repoIdentity(cwd);
      workspaceIds = [...(identityMap.get(identity) || [])];
    }
    return {
      pid: s.pid,
      kind: s.kind,
      tty: s.tty,
      cwd,
      tracked: isTracked,
      workspace_ids: workspaceIds,
      last_seen: Date.now(),
    };
  });

  const merged = mergeRegistry(previousEntries, fresh);

  writeJsonAtomic(REGISTRY_PATH, {
    generated_at: new Date().toISOString(),
    poll_interval_ms: POLL_MS,
    dry_run: DRY_RUN,
    entries: merged,
  });

  const matchedByWorkspace = new Map();
  for (const entry of merged) {
    if (entry.tracked || entry.stale) continue;
    for (const wsId of entry.workspace_ids) {
      if (!matchedByWorkspace.has(wsId)) matchedByWorkspace.set(wsId, new Set());
      matchedByWorkspace.get(wsId).add(entry.kind);
    }
  }
  reportBadges(matchedByWorkspace);

  return merged;
}

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });
  const user = currentUser();
  log(`agent-radar watcher starting (user=${user}, poll=${POLL_MS}ms, dry_run=${DRY_RUN})`);

  let entries = loadJson(REGISTRY_PATH, { entries: [] }).entries || [];

  while (true) {
    if (!stillEnabled()) {
      log("plugin disabled or unlinked, exiting");
      break;
    }
    try {
      entries = pollOnce(user, entries);
    } catch (err) {
      log(`poll error: ${err?.stack || err}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main();
