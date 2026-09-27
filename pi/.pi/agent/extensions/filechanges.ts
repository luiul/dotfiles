/**
 * File-change tracking for pi (session-cumulative edition).
 *
 * You mostly review/revert through VS Code, so this extension does one thing:
 * make sure you never lose track of which files pi touched in this session.
 *
 * Model (vocabulary: docs/filechanges-design.md):
 * - Original: the content a file had the first time it was touched this
 *   session. All counts are measured against the Original, not git HEAD, so
 *   pre-session dirt is never attributed to the agent.
 * - Change: one file whose current content differs from its Original. Has a
 *   path, a kind (created/modified/deleted), and +added/-removed counts.
 * - Session set: every Change since session start or the last Clear. It
 *   accumulates across prompts and never resets on its own.
 * - Revert: when a file's content equals its Original again, its Change
 *   leaves the Session set automatically (content compare, not line counts).
 *
 * Tracking:
 * - `edit`/`write` tool calls are tracked at any path, inside or outside a
 *   repo. `bash` changes are detected by diffing `git status --porcelain`
 *   before/after each call, only when cwd is inside a git repo (known limit:
 *   bash changes outside a repo are not detected).
 * - Counts come from `git diff --no-index --numstat` (no npm dependency).
 *   Binary files are detected via a NUL-byte sniff and shown as "(binary)".
 * - Noisy paths (lockfiles, node_modules, build output, .env*) are excluded
 *   by default; override via `filechanges.ignore` in `.pi/settings.json`
 *   (project) or `~/.pi/agent/settings.json` (global), project wins.
 *
 * Rendering:
 * - Panel: a persistent widget above the editor, live on every change. One
 *   row per Change (`modified path (+1/-2)`), most recently touched first,
 *   capped at 8 rows plus an overflow line (pi truncates widgets past 10
 *   lines). Hidden when the Session set is empty.
 * - `/filechanges` prints the full Session set into the transcript as dim
 *   lines (up to 30 rows, then an overflow note).
 * - `/filechanges-clear` empties the Session set and forgets all Originals.
 *   Tracking restarts from that point: a file edited again gets a fresh
 *   Original, so its counts are measured from the post-Clear state.
 *
 * Persistence:
 * - On `agent_settled`, the Session set is persisted via `pi.appendEntry()`,
 *   but only when something changed since the last settle (the dirty flag).
 * - On `session_start`/`session_tree` the set is restored, so `/reload` or a
 *   resumed session doesn't blank the Panel. Inside a git repo, Originals are
 *   re-captured from `git show HEAD:<path>` so edits after a reload keep
 *   sensible counts; outside a repo, restored counts stay frozen as recorded.
 * - Display-only persistence: there is no revert/accept-decline here.
 *
 * On notification delivery: `ctx.ui.notify`/`setWidget` are fire-and-forget
 * in every mode. In the TUI they render directly; in RPC mode (e.g. an
 * editor integration) they're emitted as `extension_ui_request` events on
 * stdout, which the RPC client may render or silently ignore per the pi RPC
 * spec. There's no extension-side way to guarantee a specific RPC client
 * surfaces them. If changes aren't visible in your editor, check whether its
 * pi integration handles `notify`/`setWidget` extension UI requests.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isBashToolResult, isEditToolResult, isToolCallEventType, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ENTRY_SESSION_SET = "filechanges:session-set";

const PANEL_MAX_ROWS = 8;
const LIST_MAX_ROWS = 30;
const BINARY_SNIFF_BYTES = 8000;

const DEFAULT_IGNORE = [
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"*.lock",
	".env",
	".env.*",
	"**/node_modules/**",
	"**/dist/**",
	"**/build/**",
	"**/.git/**",
];

type FileSnapshot = { buf: Buffer | null; binary: boolean };

/** File content captured at first touch this session. The reference for counts and revert detection. */
type Original = { absPath: string; snapshot: FileSnapshot };

type Kind = "created" | "modified" | "deleted";
const KINDS = new Set<string>(["created", "modified", "deleted"]);

/** One file whose current content differs from its Original. */
type Change = {
	path: string; // display path, relative to ctx.cwd where possible
	absPath: string;
	kind: Kind;
	added: number;
	removed: number;
	binary: boolean;
	updatedAt: number;
};

type PendingSnapshot = {
	path: string;
	absPath: string;
	before: FileSnapshot;
};

function stripAtPrefix(p: string): string {
	return p.startsWith("@") ? p.slice(1) : p;
}

function normalizeToolPath(cwd: string, raw: string): { absPath: string; relPath: string } {
	const cleaned = stripAtPrefix(raw);
	const absPath = resolve(cwd, cleaned);
	const rel = relative(cwd, absPath);
	const relPath = rel && !rel.startsWith("..") && rel !== "" ? rel : cleaned;
	return { absPath, relPath };
}

function isBinaryBuffer(buf: Buffer): boolean {
	const len = Math.min(buf.length, BINARY_SNIFF_BYTES);
	for (let i = 0; i < len; i++) {
		if (buf[i] === 0) return true;
	}
	return false;
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
	if (a === null || b === null) return a === b;
	return a.equals(b);
}

async function readFileSnapshot(absPath: string): Promise<FileSnapshot> {
	try {
		const buf = await readFile(absPath);
		return { buf, binary: isBinaryBuffer(buf) };
	} catch {
		return { buf: null, binary: false };
	}
}

function countLines(text: string): number {
	if (text === "") return 0;
	return text.split("\n").length;
}

function countsText(t: Change): string {
	return t.binary ? "(binary)" : `(+${t.added}/-${t.removed})`;
}

/** Shared row renderer, used by the Panel and by `/filechanges`. Plain words, no glyphs. */
function formatChangeLine(t: Change, theme?: any): string {
	const label = t.kind.padEnd(9); // "modified" is the longest kind at 8 chars
	if (!theme) return `${label}${t.path} ${countsText(t)}`;
	const prefix = theme.fg("muted", label) + theme.fg("muted", `${t.path} `);
	let counts: string;
	if (t.binary) {
		counts = theme.fg("muted", "(binary)");
	} else {
		const plus = t.added === 0 ? theme.fg("text", `+${t.added}`) : theme.fg("success", `+${t.added}`);
		const minus = t.removed === 0 ? theme.fg("text", `-${t.removed}`) : theme.fg("error", `-${t.removed}`);
		counts = theme.fg("text", "(") + plus + theme.fg("text", "/") + minus + theme.fg("text", ")");
	}
	return prefix + counts;
}

/** Panel content: header plus up to PANEL_MAX_ROWS rows plus an overflow line (10 lines, pi's widget limit). */
function buildPanelLines(sessionSet: Map<string, Change>, theme?: any): string[] | undefined {
	if (sessionSet.size === 0) return undefined;
	const items = [...sessionSet.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	const header = `Session changes (${items.length}):`;
	const lines: string[] = [theme ? theme.fg("muted", header) : header];

	const shown = items.slice(0, PANEL_MAX_ROWS);
	for (const t of shown) lines.push(formatChangeLine(t, theme));
	if (items.length > shown.length) {
		const more = `…and ${items.length - shown.length} more (see /filechanges)`;
		lines.push(theme ? theme.fg("dim", more) : more);
	}
	return lines;
}

/** Minimal glob support: `*` = any chars except `/`, `**` = any chars including `/`. */
function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
				if (glob[i + 1] === "/") i++;
			} else {
				re += "[^/]*";
			}
		} else if ("\\^$.|?+()[]{}".includes(c)) {
			re += `\\${c}`;
		} else {
			re += c;
		}
	}
	return new RegExp(`^${re}$`);
}

function isIgnored(relPath: string, patterns: string[]): boolean {
	const normalized = relPath.split(sep).join("/");
	const base = normalized.split("/").pop() ?? normalized;
	return patterns.some((pattern) => {
		if (pattern.includes("/")) return globToRegExp(pattern).test(normalized);
		// Bare filename pattern (e.g. "*.lock", "package-lock.json"): match at any depth.
		return globToRegExp(`**/${pattern}`).test(normalized) || globToRegExp(pattern).test(base);
	});
}

function readIgnoreConfig(cwd: string): string[] {
	const candidates = [join(cwd, ".pi", "settings.json"), join(homedir(), ".pi", "agent", "settings.json")];
	for (const path of candidates) {
		try {
			const raw = JSON.parse(readFileSync(path, "utf8")) as { filechanges?: { ignore?: unknown } };
			const ignore = raw?.filechanges?.ignore;
			if (Array.isArray(ignore) && ignore.every((x) => typeof x === "string")) {
				return ignore as string[];
			}
		} catch {
			// Missing or malformed settings file: try the next candidate.
		}
	}
	return DEFAULT_IGNORE;
}

function sanitizeRestored(item: any): Change | null {
	if (!item || typeof item.path !== "string" || typeof item.absPath !== "string") return null;
	if (!KINDS.has(item.kind)) return null;
	return {
		path: item.path,
		absPath: item.absPath,
		kind: item.kind,
		added: Number.isFinite(item.added) ? item.added : 0,
		removed: Number.isFinite(item.removed) ? item.removed : 0,
		binary: item.binary === true,
		updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
	};
}

export default function (pi: ExtensionAPI) {
	// The Session set: every Change since session start or the last Clear.
	// Accumulates across prompts; never resets on its own.
	const sessionSet = new Map<string, Change>();
	// One Original per touched file, captured at first touch. Later touches of
	// the same file compare against it, so no-op tool calls don't erase real
	// changes and counts stay measured from the session's perspective.
	const originals = new Map<string, Original>();
	const pendingByToolCallId = new Map<string, PendingSnapshot>();
	const pendingBashSnapshots = new Map<string, { repoRoot: string; before: Set<string> } | null>();

	// True if any file change was tracked since the last `agent_settled`. Drives
	// whether that settle actually reconciles and persists anything.
	let dirtySinceSettle = false;

	let gitAvailable = true;
	let repoRootCache: { cwd: string; root: string | null } | null = null;
	let realCwdCache: { cwd: string; real: string } | null = null;
	let ignoreCache: { cwd: string; patterns: string[] } | null = null;

	// git reports resolved paths, so bash-detected files need the resolved cwd
	// too (e.g. macOS /var -> /private/var), otherwise display paths fall back
	// to absolute inside the repo.
	async function getRealCwd(cwd: string): Promise<string> {
		if (realCwdCache?.cwd === cwd) return realCwdCache.real;
		let real = cwd;
		try {
			real = await realpath(cwd);
		} catch {
			// Unresolvable cwd: keep it as-is.
		}
		realCwdCache = { cwd, real };
		return real;
	}

	function getIgnorePatterns(cwd: string): string[] {
		if (!ignoreCache || ignoreCache.cwd !== cwd) {
			ignoreCache = { cwd, patterns: readIgnoreConfig(cwd) };
		}
		return ignoreCache.patterns;
	}

	function updateUi(ctx: ExtensionContext) {
		if (!ctx?.hasUI) return;
		ctx.ui.setWidget("filechanges", buildPanelLines(sessionSet, ctx.ui.theme));
	}

	function persistSessionSet() {
		pi.appendEntry(ENTRY_SESSION_SET, { items: [...sessionSet.values()], timestamp: Date.now() });
	}

	async function restoreSessionSet(ctx: ExtensionContext) {
		let data: any = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_SESSION_SET) data = entry.data;
		}
		sessionSet.clear();
		originals.clear();
		if (data?.items && Array.isArray(data.items)) {
			for (const item of data.items) {
				const change = sanitizeRestored(item);
				if (change) sessionSet.set(change.path, change);
			}
		}
		// Re-capture Originals from git HEAD so edits after a reload keep sensible
		// counts. Files outside the repo keep no Original: their restored counts
		// stay frozen as recorded until the next touch captures a fresh Original.
		const repoRoot = await getRepoRoot(ctx.cwd);
		if (repoRoot) {
			for (const change of sessionSet.values()) {
				const rel = relative(repoRoot, change.absPath);
				if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
				const snapshot = await readGitHeadSnapshot(repoRoot, rel.split(sep).join("/"));
				originals.set(change.path, { absPath: change.absPath, snapshot });
			}
		}
		dirtySinceSettle = false;
		updateUi(ctx);
	}

	/** `/filechanges`: print the full Session set into the transcript as dim lines. */
	function listSessionSet(ctx: ExtensionContext) {
		if (sessionSet.size === 0) {
			if (ctx.hasUI) ctx.ui.notify("filechanges: no files changed this session.", "info");
			else console.log("[filechanges] no files changed this session.");
			return;
		}
		const items = [...sessionSet.values()].sort((a, b) => b.updatedAt - a.updatedAt);
		const shown = items.slice(0, LIST_MAX_ROWS);
		const lines = [`Session changes (${items.length}):`, ...shown.map((t) => formatChangeLine(t))];
		if (items.length > shown.length) lines.push(`  …and ${items.length - shown.length} more`);
		const body = lines.join("\n");
		if (ctx.hasUI) ctx.ui.notify(body, "info");
		else console.log(`[filechanges] ${body}`);
	}

	/** Line-count diff via `git diff --no-index --numstat` (works outside a repo too, no npm dep). */
	async function computeDiffStats(cwd: string, before: string | null, after: string | null): Promise<{ added: number; removed: number }> {
		if (before === after) return { added: 0, removed: 0 };

		if (!gitAvailable) {
			if (before === null) return { added: countLines(after ?? ""), removed: 0 };
			if (after === null) return { added: 0, removed: countLines(before ?? "") };
			return { added: 0, removed: 0 };
		}

		const dir = await mkdtemp(join(tmpdir(), "pi-filechanges-"));
		const beforePath = join(dir, "a");
		const afterPath = join(dir, "b");
		try {
			await writeFile(beforePath, before ?? "", "utf-8");
			await writeFile(afterPath, after ?? "", "utf-8");

			let stdout = "";
			try {
				const res = await execFileAsync("git", ["diff", "--no-index", "--numstat", beforePath, afterPath], { cwd });
				stdout = res.stdout;
			} catch (e: any) {
				if (e?.code === "ENOENT") {
					gitAvailable = false;
					return computeDiffStats(cwd, before, after);
				}
				// git diff --no-index exits with code 1 when differences are found; stdout still has the stats.
				stdout = typeof e?.stdout === "string" ? e.stdout : "";
			}

			const parts = stdout.trim().split(/\s+/);
			const added = Number(parts[0]);
			const removed = Number(parts[1]);
			return { added: Number.isFinite(added) ? added : 0, removed: Number.isFinite(removed) ? removed : 0 };
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	function ensureOriginal(path: string, absPath: string, beforeSnap: FileSnapshot) {
		if (!originals.has(path)) originals.set(path, { absPath, snapshot: beforeSnap });
	}

	/** Re-compare one file against its Original and update (or drop, on Revert) its Change. */
	async function refreshChange(ctx: ExtensionContext, path: string): Promise<void> {
		const original = originals.get(path);
		if (!original) return;

		const current = await readFileSnapshot(original.absPath);
		if (buffersEqual(original.snapshot.buf, current.buf)) {
			// Revert: back to its Original, so it drops off the Session set by itself.
			sessionSet.delete(path);
			return;
		}

		const kind: Kind = original.snapshot.buf === null ? "created" : current.buf === null ? "deleted" : "modified";
		const binary = original.snapshot.binary || current.binary;

		let added = 0;
		let removed = 0;
		if (!binary) {
			const stats = await computeDiffStats(
				ctx.cwd,
				original.snapshot.buf === null ? null : original.snapshot.buf.toString("utf-8"),
				current.buf === null ? null : current.buf.toString("utf-8"),
			);
			added = stats.added;
			removed = stats.removed;
		}

		sessionSet.set(path, { path, absPath: original.absPath, kind, added, removed, binary, updatedAt: Date.now() });
	}

	async function trackChange(ctx: ExtensionContext, path: string, absPath: string, beforeSnap: FileSnapshot): Promise<void> {
		dirtySinceSettle = true;
		ensureOriginal(path, absPath, beforeSnap);
		await refreshChange(ctx, path);
		updateUi(ctx);
	}

	// --- git helpers for bash-driven change detection ---

	async function getRepoRoot(cwd: string): Promise<string | null> {
		if (repoRootCache && repoRootCache.cwd === cwd) return repoRootCache.root;
		if (!gitAvailable) {
			repoRootCache = { cwd, root: null };
			return null;
		}
		try {
			const res = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
			const root = res.stdout.trim();
			repoRootCache = { cwd, root: root || null };
			return repoRootCache.root;
		} catch (e: any) {
			if (e?.code === "ENOENT") gitAvailable = false;
			repoRootCache = { cwd, root: null };
			return null;
		}
	}

	// `-z` gives NUL-delimited, byte-exact paths with NO quoting/escaping, unlike
	// the default human-readable format which C-style-escapes unicode/special
	// characters into a form that isn't valid JSON and is easy to mis-unescape.
	// Renames/copies emit two tokens: the path first, then the origin path.
	function parsePorcelainZ(stdout: string): Set<string> {
		const paths = new Set<string>();
		const tokens = stdout.split("\0").filter((t) => t.length > 0);
		let i = 0;
		while (i < tokens.length) {
			const entry = tokens[i];
			const statusX = entry[0];
			const statusY = entry[1];
			paths.add(entry.slice(3));
			if (statusX === "R" || statusX === "C" || statusY === "R" || statusY === "C") {
				i++;
				if (i < tokens.length) paths.add(tokens[i]);
			}
			i++;
		}
		return paths;
	}

	async function snapshotGitStatus(repoRoot: string): Promise<Set<string>> {
		try {
			const res = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
				cwd: repoRoot,
				maxBuffer: 10 * 1024 * 1024,
			});
			return parsePorcelainZ(res.stdout);
		} catch (e: any) {
			if (e?.code === "ENOENT") gitAvailable = false;
			return new Set();
		}
	}

	async function readGitHeadSnapshot(repoRoot: string, repoRelPath: string): Promise<FileSnapshot> {
		try {
			const res = await execFileAsync("git", ["show", `HEAD:${repoRelPath}`], {
				cwd: repoRoot,
				encoding: "buffer",
				maxBuffer: 20 * 1024 * 1024,
			});
			const buf = res.stdout as unknown as Buffer;
			return { buf, binary: isBinaryBuffer(buf) };
		} catch (e: any) {
			if (e?.code === "ENOENT") gitAvailable = false;
			return { buf: null, binary: false }; // not committed at HEAD (new/untracked file), or git unavailable
		}
	}

	// Capture before-snapshots for edit/write calls, and a git-status snapshot
	// before bash calls (used to detect which files a bash command touched).
	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
			const { absPath, relPath } = normalizeToolPath(ctx.cwd, (event.input as any).path);
			if (isIgnored(relPath, getIgnorePatterns(ctx.cwd))) return;
			const before = await readFileSnapshot(absPath);
			pendingByToolCallId.set(event.toolCallId, { path: relPath, absPath, before });
			return;
		}
		if (isToolCallEventType("bash", event)) {
			const repoRoot = await getRepoRoot(ctx.cwd);
			if (!repoRoot) {
				pendingBashSnapshots.set(event.toolCallId, null);
				return;
			}
			const before = await snapshotGitStatus(repoRoot);
			pendingBashSnapshots.set(event.toolCallId, { repoRoot, before });
		}
	});

	// Commit on successful results.
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) {
			pendingByToolCallId.delete(event.toolCallId);
			pendingBashSnapshots.delete(event.toolCallId);
			return;
		}

		if (isEditToolResult(event) || isWriteToolResult(event)) {
			const pending = pendingByToolCallId.get(event.toolCallId);
			pendingByToolCallId.delete(event.toolCallId);
			if (!pending) return;
			await trackChange(ctx, pending.path, pending.absPath, pending.before);
			return;
		}

		if (isBashToolResult(event)) {
			const snap = pendingBashSnapshots.get(event.toolCallId);
			pendingBashSnapshots.delete(event.toolCallId);
			if (!snap) return; // not a git repo, or wasn't captured (e.g. errored before tool_call ran)

			const after = await snapshotGitStatus(snap.repoRoot);
			const touched = new Set<string>();
			for (const p of snap.before) if (!after.has(p)) touched.add(p);
			for (const p of after) if (!snap.before.has(p)) touched.add(p);
			if (touched.size === 0) return;

			// Resolve and filter BEFORE tracking: a bash call that only touched
			// ignored paths (e.g. `npm install` bumping package-lock.json) must not
			// mark the Session set dirty or surface irrelevant rows.
			const patterns = getIgnorePatterns(ctx.cwd);
			const realCwd = await getRealCwd(ctx.cwd);
			const relevant: { repoRelPath: string; absPath: string; relPath: string }[] = [];
			for (const repoRelPath of touched) {
				const absPath = resolve(snap.repoRoot, repoRelPath);
				const { relPath } = normalizeToolPath(realCwd, absPath);
				if (isIgnored(relPath, patterns)) continue;
				relevant.push({ repoRelPath, absPath, relPath });
			}
			if (relevant.length === 0) return;

			for (const { repoRelPath, absPath, relPath } of relevant) {
				dirtySinceSettle = true;
				if (!originals.has(relPath)) {
					const beforeSnap = await readGitHeadSnapshot(snap.repoRoot, repoRelPath);
					ensureOriginal(relPath, absPath, beforeSnap);
				}
				await refreshChange(ctx, relPath);
			}
			updateUi(ctx);
		}
	});

	// Once pi hands control back: reconcile every tracked file, refresh the
	// Panel, and persist (cheap no-op when nothing changed since the last settle).
	pi.on("agent_settled", async (_event, ctx) => {
		if (!dirtySinceSettle) return;
		// Final consistency sweep: catches drift from e.g. a bash command that
		// touched an already-tracked file a second time within the same turn.
		for (const path of [...originals.keys()]) {
			await refreshChange(ctx, path);
		}
		dirtySinceSettle = false;
		updateUi(ctx);
		// Persist even when the sweep reverted every Change: the empty entry
		// overwrites earlier ones so a reload doesn't resurrect stale rows.
		persistSessionSet();
	});

	pi.on("session_start", async (_event, ctx) => restoreSessionSet(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreSessionSet(ctx));

	pi.registerCommand("filechanges", {
		description: "List files changed this session",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			updateUi(ctx);
			listSessionSet(ctx);
		},
	});

	pi.registerCommand("filechanges-clear", {
		description: "Clear the session change list and restart tracking",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			sessionSet.clear();
			originals.clear();
			dirtySinceSettle = false;
			updateUi(ctx);
			// Persist the empty set so a /reload doesn't resurrect the cleared list.
			persistSessionSet();
			if (ctx.hasUI) ctx.ui.notify("filechanges: cleared. Tracking restarts from the next change.", "info");
			else console.log("[filechanges] cleared.");
		},
	});
}
