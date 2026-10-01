const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Candidate sources: every workspace root, plus every repo registered in the
// worktrunk known-repos registry (one absolute path per line). For each repo,
// `git worktree list --porcelain` yields the main checkout and all linked
// worktrees. Results are cached briefly; `wtHop.refresh` forces a rescan.
const KNOWN_REPOS_FILE = path.join(os.homedir(), ".cache", "wt", "known-repos");
const CACHE_TTL_MS = 15000;

let cache = null;

function gitWorktrees(repoRoot) {
  let out;
  try {
    out = cp.execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
  } catch {
    return [];
  }
  const results = [];
  let current = null;
  const flush = () => {
    if (current) results.push(current);
    current = null;
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = { path: line.slice("worktree ".length), branch: null };
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return results;
}

function knownRepos() {
  let text;
  try {
    text = fs.readFileSync(KNOWN_REPOS_FILE, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && fs.existsSync(l));
}

function collectCandidates() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.items;

  const workspaceRoots = new Set(
    (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath)
  );
  const repos = [...new Set([...workspaceRoots, ...knownRepos()])];
  const byPath = new Map();

  for (const repo of repos) {
    const worktrees = gitWorktrees(repo);
    if (!worktrees.length) continue;
    // The main checkout is the first porcelain entry; its basename is the
    // most stable repo name, even when scanning from a linked worktree.
    const repoName = path.basename(worktrees[0].path);
    for (const wt of worktrees) {
      if (byPath.has(wt.path)) continue;
      byPath.set(wt.path, {
        repo: repoName,
        branch: wt.branch || path.basename(wt.path),
        path: wt.path,
        inWorkspace: workspaceRoots.has(wt.path),
      });
    }
  }

  const items = [...byPath.values()].sort((a, b) =>
    a.inWorkspace === b.inWorkspace
      ? `${a.repo}:${a.branch}`.localeCompare(`${b.repo}:${b.branch}`)
      : a.inWorkspace
        ? -1
        : 1
  );
  cache = { at: now, items };
  return items;
}

function terminalCwd(term) {
  const opts = term.creationOptions || {};
  let cwd = opts.cwd;
  if (cwd && typeof cwd !== "string") cwd = cwd.fsPath; // Uri
  if (!cwd && term.shellIntegration && term.shellIntegration.cwd) {
    cwd = term.shellIntegration.cwd.fsPath;
  }
  return typeof cwd === "string" ? cwd : undefined;
}

async function switchTarget() {
  const candidates = collectCandidates();
  if (!candidates.length) {
    vscode.window.showInformationMessage("WT Hop: no repos found.");
    return;
  }

  const items = candidates.map((c) => ({
    label: `$(git-branch) ${c.repo}:${c.branch}`,
    description: c.path.replace(os.homedir(), "~"),
    detail: c.inWorkspace
      ? "in workspace"
      : "will be added to the workspace (no reload)",
    cand: c,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Jump to a repo/worktree (lands in its terminal)",
    matchOnDescription: true,
  });
  if (!pick) return;
  const { cand } = pick;

  // Append only, never remove or reorder: index 0 stays put, so VS Code does
  // not reload the window or restart the extension host, and other sidebar
  // roots stay visible. (First hop from an empty window does reload: the
  // 0-to-1-folder transition enters a workspace. Rare and harmless.)
  const rootsNow = (vscode.workspace.workspaceFolders || []).map(
    (f) => f.uri.fsPath
  );
  if (!rootsNow.includes(cand.path)) {
    vscode.workspace.updateWorkspaceFolders(rootsNow.length, 0, {
      uri: vscode.Uri.file(cand.path),
      name: `${cand.repo}:${cand.branch}`,
    });
  }

  // Jump-back-into-session semantics: reuse the terminal already tied to
  // this target (by repo:branch name, falling back to cwd). Only spawn a
  // new one when the target has no terminal yet.
  const termName = `${cand.repo}:${cand.branch}`;
  const existing =
    vscode.window.terminals.find((t) => t.name === termName) ||
    vscode.window.terminals.find((t) => terminalCwd(t) === cand.path);
  if (existing) {
    existing.show();
    return;
  }
  vscode.window.createTerminal({ name: termName, cwd: cand.path }).show();
}

function refresh() {
  cache = null;
  vscode.window.showInformationMessage("WT Hop: repo/worktree list refreshed.");
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("wtHop.switch", switchTarget),
    vscode.commands.registerCommand("wtHop.refresh", refresh)
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
