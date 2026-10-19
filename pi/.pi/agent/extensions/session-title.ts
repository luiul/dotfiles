/**
 * session-title: keeps the terminal window title path-bearing while pi
 * runs, so canopy and understory (via dashkit/mycelium) can identify
 * this window by title.
 *
 * pi's own title is "π - <cwd basename>" ("π - <session> - <basename>"
 * for named sessions), which cannot identify a window: same-named
 * folders collide, and the basename says nothing about the path. The
 * zsh hook (~/.zsh_config/title.zsh) renders a path-bearing title at
 * every shell prompt, but pi overwrites it at startup, and the zsh
 * precmd only runs again once pi exits.
 *
 * This extension re-asserts the same grammar the zsh hook renders,
 * with a π marker so a pi session stays recognizable at a glance:
 *
 *   "π • <work-tree root> • <branch> • ttys034"     inside a git worktree
 *   "π • <path> • ttys034"                          outside any repo
 *
 * The trailing tty is this surface's identity: two agents side by
 * side in the same repo on the same branch have identical path
 * components, and canopy (which resolves every agent's tty via ps)
 * uses it to raise the exact window. When the tty can't be resolved,
 * the title stays without it and matching falls back to the path.
 *
 * mycelium's Ghostty matching parses the rightmost " • "-separated
 * segment that is an absolute or ~-shortened path, so it reads this
 * title exactly like the zsh hook's "<root> • <branch>" and the
 * running-command variant "cmd • <root> • <branch>".
 *
 * Timing: pi sets its own title ("π - basename") after extension
 * handlers for session_start have run, and again on a session rename
 * (session_info_changed). Observed on a heavy extension set, that
 * write lands ~2s after launch, so any single re-assert loses the
 * race. The extension therefore re-asserts on a short bounded retry
 * schedule after those two events (300ms to 10s), letting pi's write
 * land and then having the last word. Every agent turn re-asserts
 * synchronously too (agent_start/agent_settled), so the title is
 * path-bearing from the first prompt onward regardless.
 *
 * The transition this guards: before pi starts, the zsh hook owns the
 * title ("root • branch", path-bearing); pi's startup write replaces
 * it with "π - basename" (no path); the extension restores the
 * path-bearing grammar within seconds. If a re-assert somehow still
 * loses, the title self-corrects at the next event; a wrong-title
 * window simply doesn't match, and the jumpers open a new window
 * rather than focus a guess. Sessions started before this extension
 * existed keep pi's unparseable title until they are restarted.
 *
 * Session replacement (/new, fork, switch, reload) invalidates the ctx
 * a pending retry captured; pi throws on any use of a stale ctx, so
 * retry batches are generation-tagged and retire on replacement, and
 * the title call itself is fully guarded as a backstop.
 *
 * Only interactive sessions set the title: subagent child sessions and
 * non-TUI modes (ctx.hasUI false) have no window of their own.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

let ttyCache: string | undefined;

/**
 * surfaceTty is this terminal's short tty name ("ttys034", the form
 * `ps -o tty=` reports and canopy resolves for every agent), resolved
 * once per process: the tty never changes during a session. Appended to
 * the title so two agents side by side in the same repo on the same
 * branch — same root, same branch, identical path component — stay
 * distinguishable. "" when it can't be resolved (no tty segment).
 */
function surfaceTty(): string {
	if (ttyCache === undefined) {
		ttyCache = "";
		try {
			const out = spawnSync("ps", ["-o", "tty=", "-p", String(process.pid)], { encoding: "utf8" });
			const tty = (out.stdout ?? "").trim();
			if (/^ttys\d+$/.test(tty)) ttyCache = tty;
		} catch {
			// No tty segment; the title stays path-only.
		}
	}
	return ttyCache;
}

/**
 * repoInfo walks up from dir to the enclosing git worktree, mirroring
 * the zsh hook's own walk: a .git directory is a main checkout, a .git
 * file is a linked worktree's "gitdir: <path>" pointer. Returns the
 * worktree root and the checked-out branch (short hash for a detached
 * HEAD), or null outside any repo.
 */
function repoInfo(dir: string): { root: string; branch: string } | null {
	let cur = dir;
	while (true) {
		const git = join(cur, ".git");
		if (existsSync(git)) {
			let gitdir = git;
			if (!statSync(git).isDirectory()) {
				// Linked worktree: .git is a pointer file.
				const g = readFileSync(git, "utf8").trim().replace(/^gitdir:/, "").trim();
				if (!g || !existsSync(g)) return null;
				gitdir = g;
			}
			const head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
			const m = head.match(/^ref: refs\/heads\/(.+)$/);
			return { root: cur, branch: m ? m[1] : head.slice(0, 7) };
		}
		const parent = dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}

/** shorten contracts home to ~, the same rendering the zsh hook uses. */
function shorten(p: string): string {
	const home = homedir();
	if (p === home) return "~";
	if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
	return p;
}

/**
 * sessionTitle is this window's title, the zsh hook's grammar plus the
 * surface tty: "π • <work-tree root> • <branch> • ttys034", or
 * "π • <path> • ttys034" outside any repo.
 */
function sessionTitle(): string {
	const cwd = process.cwd();
	const info = repoInfo(cwd);
	const base = info ? `π • ${shorten(info.root)} • ${info.branch}` : `π • ${shorten(cwd)}`;
	const tty = surfaceTty();
	return tty ? `${base} • ${tty}` : base;
}

export default function (pi: ExtensionAPI) {
	// generation invalidates pending retry batches when the session is
	// replaced: each reassertAfterPi call schedules its batch under the
	// current generation and bumps it, so the previous session's pending
	// timers retire quietly instead of touching their now-stale ctx
	// (pi forbids captured ctxs after newSession/fork/switchSession/
	// reload, and throws on use — that exact throw crashed pi here
	// before). The replacement session's own session_start schedules a
	// fresh batch.
	let generation = 0;

	const set = (ctx: ExtensionContext) => {
		// The whole call is guarded, hasUI access included: a timer that
		// slips through the generation check (e.g. a reload path with no
		// follow-up session_start) still degrades to a quiet no-op
		// instead of an uncaughtException.
		try {
			if (!ctx.hasUI) return;
			ctx.ui.setTitle(sessionTitle());
		} catch {
			// A stale or non-interactive ctx: nothing to title.
		}
	};

	// pi writes its own title after extension handlers for these events
	// have run; a single timeout loses that race (see the file doc), so
	// re-assert on a dense bounded schedule and have the last word.
	const retriesMs = [300, 1000, 2000, 3000, 4000, 5000, 7000, 10000, 15000];
	const reassertAfterPi = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const gen = ++generation;
		for (const ms of retriesMs) {
			setTimeout(() => {
				if (gen === generation) set(ctx);
			}, ms);
		}
	};

	pi.on("session_start", async (_event, ctx) => reassertAfterPi(ctx));
	pi.on("session_info_changed", async (_event, ctx) => reassertAfterPi(ctx));
	pi.on("agent_start", async (_event, ctx) => set(ctx));
	pi.on("agent_settled", async (_event, ctx) => set(ctx));
}
