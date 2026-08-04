// herdr-agent-state-external.ts
// @ts-nocheck
//
// Companion to herdr's own managed ~/.pi/agent/extensions/herdr-agent-state.ts.
//
// That hook only works when pi runs inside a pty herdr itself spawned: herdr
// injects HERDR_ENV/HERDR_SOCKET_PATH/HERDR_PANE_ID into panes it owns, and the
// managed hook reports agent state to herdr over that socket. When pi is started
// somewhere herdr never touched -- e.g. VS Code's own integrated terminal opened
// directly from the Dock/Finder -- those env vars are absent and the agent is
// invisible to herdr's sidebar, even if herdr has a workspace/pane registered for
// that same directory (see: `herdr agent explain <pane>` -> "agent target ... not
// found" while a real `pi` process is running in that directory).
//
// This extension covers that gap: when the native hook is not active, it finds
// (or creates) a herdr workspace/pane whose cwd matches this process's cwd, and
// reports pi's agent lifecycle into it via the `herdr` CLI (`herdr pane
// report-agent` / `report-agent-session` / `release-agent`), which needs no
// socket env vars, just the herdr server to be reachable.
//
// Do not edit herdr-agent-state.ts -- herdr overwrites it whenever the "pi"
// integration is reinstalled/updated. This file lives beside it and is untouched
// by that process, per herdr's own instructions in that file's header.
//
// Opt out with PI_HERDR_EXTERNAL_DISABLE=1.

import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";
const SOURCE = "herdr:pi-external";
const DISABLED = process.env.PI_HERDR_EXTERNAL_DISABLE === "1";

type AgentState = "working" | "blocked" | "idle";

// The managed hook already covers this case -- don't double-report the same
// agent through two sources for the same real pane.
function nativeHookActive(): boolean {
  return (
    process.env.HERDR_ENV === "1" &&
    !!process.env.HERDR_SOCKET_PATH &&
    !!process.env.HERDR_PANE_ID
  );
}

function runHerdr(args: string[], timeoutMs = 2500): Promise<any> {
  return new Promise((resolve) => {
    try {
      execFile(
        HERDR_BIN,
        args,
        { timeout: timeoutMs, windowsHide: true },
        (err, stdout) => {
          if (err) {
            resolve(undefined);
            return;
          }
          try {
            resolve(JSON.parse(String(stdout)));
          } catch {
            resolve(undefined);
          }
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

type SnapshotPane = { pane_id: string; cwd?: string; workspace_id?: string };

function pickBestPane(panes: SnapshotPane[], cwd: string): SnapshotPane | undefined {
  let best: SnapshotPane | undefined;
  for (const p of panes) {
    if (!p.cwd) continue;
    const isMatch = p.cwd === cwd || cwd.startsWith(p.cwd.endsWith("/") ? p.cwd : `${p.cwd}/`);
    if (!isMatch) continue;
    if (!best || (best.cwd?.length ?? 0) < p.cwd.length) {
      best = p;
    }
  }
  return best;
}

async function findPaneForCwd(cwd: string): Promise<string | undefined> {
  const snap = await runHerdr(["api", "snapshot"]);
  const panes: SnapshotPane[] = snap?.result?.snapshot?.panes ?? [];
  return pickBestPane(panes, cwd)?.pane_id;
}

async function createPaneForCwd(cwd: string): Promise<string | undefined> {
  const label = cwd.split("/").filter(Boolean).pop() || cwd;
  const created = await runHerdr([
    "workspace",
    "create",
    "--cwd",
    cwd,
    "--label",
    label,
    "--no-focus",
  ]);
  return created?.result?.root_pane?.pane_id;
}

// Cross-process mutex for the create path: two pi processes launched at
// almost the same moment in a cwd herdr has never seen (e.g. two VS Code
// terminals opened together) would otherwise both find no existing pane and
// both call `workspace create`, producing two workspaces for the same
// directory. An atomic `mkdir` (fails with EEXIST if another process holds
// it) serializes the check-then-create across processes, not just within
// one. If the lock can't be acquired within the deadline (contention, a
// stale lock from a crashed process, or no permission to write tmpdir), we
// give up and proceed unlocked rather than risk hanging pi's startup
// forever; worst case reverts to the original best-effort behavior.
function lockDirFor(cwd: string): string {
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 16);
  return join(tmpdir(), `pi-herdr-pane-lock-${hash}`);
}

async function withCwdLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const dir = lockDirFor(cwd);
  const deadline = Date.now() + 5000;
  let owned = false;
  while (!owned) {
    try {
      await mkdir(dir);
      owned = true;
    } catch (err: any) {
      if (err?.code !== "EEXIST" || Date.now() > deadline) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 150));
    }
  }
  try {
    return await fn();
  } finally {
    if (owned) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function resolvePaneId(cwd: string): Promise<string | undefined> {
  const existing = await findPaneForCwd(cwd);
  if (existing) {
    return existing;
  }
  return withCwdLock(cwd, async () => {
    // Re-check inside the lock: another process may have created a pane for
    // this cwd while we were waiting to acquire it.
    const recheck = await findPaneForCwd(cwd);
    if (recheck) {
      return recheck;
    }
    return createPaneForCwd(cwd);
  });
}

let reportSeq = Date.now() * 1000;
function nextSeq(): number {
  reportSeq += 1;
  return reportSeq;
}

async function reportAgentSession(
  paneId: string,
  sessionPath: string | undefined,
  sessionId: string | undefined,
  startSource?: string,
): Promise<void> {
  if (!sessionPath && !sessionId) {
    return;
  }
  const args = [
    "pane",
    "report-agent-session",
    paneId,
    "--source",
    SOURCE,
    "--agent",
    "pi",
    "--seq",
    String(nextSeq()),
  ];
  if (sessionPath) {
    args.push("--agent-session-path", sessionPath);
  } else if (sessionId) {
    args.push("--agent-session-id", sessionId);
  }
  if (startSource) {
    args.push("--session-start-source", startSource);
  }
  await runHerdr(args);
}

async function reportAgentState(paneId: string, state: AgentState, message?: string): Promise<void> {
  const args = [
    "pane",
    "report-agent",
    paneId,
    "--source",
    SOURCE,
    "--agent",
    "pi",
    "--state",
    state,
    "--seq",
    String(nextSeq()),
  ];
  if (message) {
    args.push("--message", message);
  }
  await runHerdr(args);
}

async function releaseAgent(paneId: string): Promise<void> {
  await runHerdr(["pane", "release-agent", paneId, "--source", SOURCE, "--agent", "pi", "--seq", String(nextSeq())]);
}

function safeGet<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export default function (pi) {
  if (DISABLED || nativeHookActive()) {
    return;
  }

  let paneId: string | undefined;
  let paneResolution: Promise<string | undefined> | undefined;
  let agentActive = false;
  let blockedCount = 0;
  let blockedMessage: string | undefined;
  let lastState: AgentState | undefined;
  let lastMessage: string | undefined;
  let rootSession = false;

  // Serialize CLI calls so overlapping async state changes can't land out of order.
  let sendChain: Promise<void> = Promise.resolve();
  function enqueue(fn: () => Promise<void>): void {
    sendChain = sendChain.then(fn, fn);
  }

  function getPaneId(): Promise<string | undefined> {
    if (!paneResolution) {
      paneResolution = resolvePaneId(process.cwd()).then((id) => {
        paneId = id;
        return id;
      });
    }
    return paneResolution;
  }

  function desiredState(): { state: AgentState; message?: string } {
    if (blockedCount > 0) {
      return { state: "blocked", message: blockedMessage };
    }
    if (agentActive) {
      return { state: "working" };
    }
    return { state: "idle" };
  }

  function publishState(force = false): void {
    const next = desiredState();
    if (!force && next.state === lastState && next.message === lastMessage) {
      return;
    }
    lastState = next.state;
    lastMessage = next.message;
    enqueue(async () => {
      const id = paneId ?? (await getPaneId());
      if (!id) return;
      await reportAgentState(id, next.state, next.message);
    });
  }

  pi.events.on("herdr:blocked", (data: any) => {
    if (!rootSession) return;
    if (!data?.active) {
      blockedCount = Math.max(0, blockedCount - 1);
      if (blockedCount === 0) blockedMessage = undefined;
      publishState();
      return;
    }
    blockedCount += 1;
    blockedMessage = data.label;
    publishState();
  });

  pi.on("session_start", (event, ctx) => {
    // TUI only: RPC/JSON/print modes are headless, nothing for herdr to show.
    if (ctx?.mode !== "tui") return;
    rootSession = true;

    const sessionPath = safeGet(() => ctx?.sessionManager?.getSessionFile?.());
    const sessionId = safeGet(() => ctx?.sessionManager?.getSessionId?.());
    agentActive = ctx?.isIdle?.() === false;

    // Don't block pi's own startup on herdr CLI round-trips; resolve and report
    // in the background.
    enqueue(async () => {
      const id = await getPaneId();
      if (!id) return;
      await reportAgentSession(id, sessionPath, sessionId, event?.reason);
      await reportAgentState(id, desiredState().state, desiredState().message);
    });
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession) return;
    const sessionPath = safeGet(() => ctx?.sessionManager?.getSessionFile?.());
    const sessionId = safeGet(() => ctx?.sessionManager?.getSessionId?.());
    agentActive = true;

    enqueue(async () => {
      const id = paneId ?? (await getPaneId());
      if (!id) return;
      await reportAgentSession(id, sessionPath, sessionId);
    });
    publishState();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!rootSession || ctx?.isIdle?.() !== true) return;
    agentActive = false;
    publishState();
  });

  pi.on("session_shutdown", () => {
    if (!rootSession) return;
    enqueue(async () => {
      const id = paneId;
      if (!id) return;
      await reportAgentState(id, "idle");
      await releaseAgent(id);
    });
  });
}
