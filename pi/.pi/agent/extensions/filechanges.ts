/**
 * File-change log for pi (simple edition).
 *
 * You mostly review/revert through VS Code, so this extension does one thing:
 * make sure you never lose track of which files pi touched in the latest
 * batch of changes (i.e. everything it did in response to your last message).
 *
 * - Tracks files created/modified/deleted via the built-in `edit`/`write`
 *   tools AND via `bash` (by diffing `git status --porcelain` before/after
 *   each bash call, when cwd is inside a git repo).
 * - A "batch" is everything changed since pi last handed control back to you.
 *   It resets on the first real file change *after* the previous
 *   `agent_settled`, not on every `before_agent_start` - this makes it
 *   immune to steering/follow-up messages re-entering the agent loop
 *   mid-stream, which would otherwise risk splitting one logical response
 *   into two displayed batches.
 * - Keeps a persistent footer status + widget above the editor showing the
 *   latest batch (survives scrollback, stays visible until the next batch).
 *   The footer status lists the changed file names (most recent first),
 *   truncated to a character budget with a "+N more" tail when the list is
 *   long. The widget is capped at a fixed number of lines; the
 *   printed/notified summary and `/filechanges` show everything.
 * - The footer status also shows a shortcut hint to open the project root
 *   in VS Code. `ctrl+shift+v` (and `/filechanges-open`) run `code <root>`,
 *   where `<root>` is the git repo root when inside one, else `ctx.cwd`.
 *   Requires the `code` CLI to be on PATH (VS Code > Shell Command: Install
 *   'code' command in PATH).
 * - Prints/notifies a summary right after the final response, with
 *   +added/-removed line counts and a running total, via `git diff
 *   --no-index` (no extra npm dependency). Binary files are detected via a
 *   NUL-byte heuristic and shown as "(binary)" instead of a misleading
 *   +0/-0.
 * - The last settled batch is persisted via `pi.appendEntry()` and restored
 *   on `session_start`/`session_tree`, so `/reload` or resuming a session
 *   doesn't blank the widget. This is display-only persistence; there is no
 *   revert/accept-decline.
 * - Noisy paths (lockfiles, node_modules, build output, .env*) are excluded
 *   by default; override via `filechanges.ignore` in `.pi/settings.json`
 *   (project) or `~/.pi/agent/settings.json` (global), project wins.
 * - `/filechanges` reprints the latest batch on demand.
 * - `/filechanges-clear` dismisses the widget/status early.
 *
 * On notification delivery: `ctx.ui.notify`/`setStatus`/`setWidget` are
 * "fire-and-forget" in every mode - in the TUI they render directly; in RPC
 * mode (e.g. an editor integration) they're emitted as `extension_ui_request`
 * events on stdout, which the RPC client may render or silently ignore per
 * the pi RPC spec. There's no extension-side way to guarantee a specific RPC
 * client surfaces them - if changes aren't visible in your editor, check
 * whether its pi integration handles `notify`/`setWidget` extension UI
 * requests.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isBashToolResult, isEditToolResult, isToolCallEventType, isWriteToolResult, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ENTRY_BATCH = "filechanges:batch";

const WIDGET_MAX_LINES = 8;
const SUMMARY_MAX_LINES = 30;
const BINARY_SNIFF_BYTES = 8000;
// Character budget for the file-name list shown in the footer status line
// (shared with other extensions' statuses, so keep it tight).
const STATUS_NAMES_BUDGET = 42;
// Longest a single file name is allowed to be before middle-truncation.
const STATUS_NAME_MAX = 24;
// Keybinding that opens the project root in VS Code (see registerShortcut below).
const OPEN_VSCODE_SHORTCUT = "ctrl+shift+v";

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

type BatchEntry = {
	path: string; // display path, relative to ctx.cwd where possible
	absPath: string;
	kind: "new" | "edited" | "deleted";
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

function tagFor(kind: BatchEntry["kind"]): string {
	return kind === "new" ? "+" : kind === "deleted" ? "-" : "Δ";
}

function labelFor(kind: BatchEntry["kind"]): string {
	return kind === "new" ? "created" : kind === "deleted" ? "deleted" : "modified";
}

function countsText(t: BatchEntry): string {
	return t.binary ? "(binary)" : `(+${t.added}/-${t.removed})`;
}

/** Keep the tail of a long name (extension/basename) visible, drop the middle. */
function truncateNameStart(name: string, maxLen: number): string {
	if (name.length <= maxLen) return name;
	return `…${name.slice(name.length - (maxLen - 1))}`;
}

/** Comma-joined file names, most-recent-first, capped to a character budget with a "+N more" tail. */
function buildNamesSummary(items: BatchEntry[]): string {
	if (items.length === 0) return "";
	const shown: string[] = [];
	let used = 0;
	for (const t of items) {
		const name = truncateNameStart(t.path, STATUS_NAME_MAX);
		const addedLen = name.length + (shown.length > 0 ? 2 : 0);
		if (shown.length > 0 && used + addedLen > STATUS_NAMES_BUDGET) break;
		shown.push(name);
		used += addedLen;
	}
	const remaining = items.length - shown.length;
	return remaining > 0 ? `${shown.join(", ")}, +${remaining} more` : shown.join(", ");
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
		// Bare filename pattern (e.g. "*.lock", "package-lock.json") - match at any depth.
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

function formatStatus(batch: Map<string, BatchEntry>, theme?: any): string | undefined {
	if (batch.size === 0) return undefined;
	const items = [...batch.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	let created = 0;
	let edited = 0;
	let deleted = 0;
	let totalAdded = 0;
	let totalRemoved = 0;
	for (const t of items) {
		if (t.kind === "new") created++;
		else if (t.kind === "deleted") deleted++;
		else edited++;
		totalAdded += t.added;
		totalRemoved += t.removed;
	}
	const parts: string[] = [];
	if (edited) parts.push(`Δ${edited}`);
	if (created) parts.push(`+${created}`);
	if (deleted) parts.push(`-${deleted}`);
	const totals = totalAdded || totalRemoved ? `  (+${totalAdded}/-${totalRemoved})` : "";
	const names = buildNamesSummary(items);
	const summary = `${names}  ${parts.join("  ")}${totals}`;
	const summaryText = theme ? theme.fg("muted", summary) : summary;
	const openHint = rawKeyHint(OPEN_VSCODE_SHORTCUT, "open in VS Code");
	return `${summaryText}  ${openHint}`;
}

function buildWidgetLines(batch: Map<string, BatchEntry>, theme?: any): string[] | undefined {
	if (batch.size === 0) return undefined;
	const items = [...batch.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	const header = "Last batch of changes:";
	const lines: string[] = [theme ? theme.fg("muted", header) : header];

	const shown = items.slice(0, WIDGET_MAX_LINES);
	for (const t of shown) {
		const tag = tagFor(t.kind);
		if (!theme) {
			lines.push(`${tag} ${t.path} ${countsText(t)}`);
			continue;
		}
		const prefix = theme.fg("muted", `${tag} `) + theme.fg("muted", `${t.path} `);
		let counts: string;
		if (t.binary) {
			counts = theme.fg("muted", "(binary)");
		} else {
			const plus = t.added === 0 ? theme.fg("text", `+${t.added}`) : theme.fg("success", `+${t.added}`);
			const minus = t.removed === 0 ? theme.fg("text", `-${t.removed}`) : theme.fg("error", `-${t.removed}`);
			counts = theme.fg("text", "(") + plus + theme.fg("text", "/") + minus + theme.fg("text", ")");
		}
		lines.push(prefix + counts);
	}
	if (items.length > shown.length) {
		const more = `…and ${items.length - shown.length} more (see /filechanges)`;
		lines.push(theme ? theme.fg("dim", more) : more);
	}
	return lines;
}

export default function (pi: ExtensionAPI) {
	// Files touched by the current/most-recent batch that actually changed something.
	// NOT cleared on every new prompt: if a prompt makes no edits, the widget keeps
	// showing the last real batch instead of going blank.
	const batch = new Map<string, BatchEntry>();
	// Content each file had at the moment it was FIRST touched in this batch, so
	// later no-op tool calls on the same file don't erase earlier real changes.
	const baselines = new Map<string, { absPath: string; original: FileSnapshot }>();
	const pendingByToolCallId = new Map<string, PendingSnapshot>();
	const pendingBashSnapshots = new Map<string, { repoRoot: string; before: Set<string> } | null>();

	// Becomes true right after `agent_settled`; the next real file change clears
	// the previous batch before recording itself. Deliberately NOT tied to
	// `before_agent_start`, so a steering/follow-up message that re-enters the
	// agent loop mid-stream can't split one logical response into two batches.
	let awaitingFreshBatch = false;
	// True if any file change was recorded since the last `agent_settled`. Drives
	// whether that settle actually reconciles/prints/persists anything.
	let batchDirtySinceSettle = false;

	let gitAvailable = true;
	let repoRootCache: { cwd: string; root: string | null } | null = null;
	let ignoreCache: { cwd: string; patterns: string[] } | null = null;

	function getIgnorePatterns(cwd: string): string[] {
		if (!ignoreCache || ignoreCache.cwd !== cwd) {
			ignoreCache = { cwd, patterns: readIgnoreConfig(cwd) };
		}
		return ignoreCache.patterns;
	}

	function updateUi(ctx: ExtensionContext) {
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus("filechanges", formatStatus(batch, ctx.ui.theme));
		ctx.ui.setWidget("filechanges", buildWidgetLines(batch, ctx.ui.theme));
	}

	function persistBatch(ctx: ExtensionContext) {
		pi.appendEntry(ENTRY_BATCH, { items: [...batch.values()], timestamp: Date.now() });
	}

	function restoreLastBatch(ctx: ExtensionContext) {
		let data: any = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_BATCH) data = entry.data;
		}
		batch.clear();
		baselines.clear();
		if (data?.items && Array.isArray(data.items)) {
			for (const item of data.items) {
				if (item && typeof item.path === "string") batch.set(item.path, item as BatchEntry);
			}
		}
		// Treat a restore like a settle: the next real edit should retire this
		// carried-over batch rather than merge into it.
		awaitingFreshBatch = true;
		batchDirtySinceSettle = false;
		updateUi(ctx);
	}

	function printSummary(ctx: ExtensionContext, header: string) {
		if (batch.size === 0) {
			if (ctx.hasUI) ctx.ui.notify("filechanges: no files changed in the latest batch.", "info");
			else console.log("[filechanges] no files changed in the latest batch.");
			return;
		}
		const items = [...batch.values()].sort((a, b) => b.updatedAt - a.updatedAt);
		let totalAdded = 0;
		let totalRemoved = 0;
		for (const t of items) {
			totalAdded += t.added;
			totalRemoved += t.removed;
		}
		const shown = items.slice(0, SUMMARY_MAX_LINES);
		const lines = shown.map((t) => `  ${labelFor(t.kind).padEnd(8)} ${t.path} ${countsText(t)}`);
		if (items.length > shown.length) lines.push(`  …and ${items.length - shown.length} more (see /filechanges)`);
		const totalsSuffix = totalAdded || totalRemoved ? ` — total +${totalAdded}/-${totalRemoved}` : "";
		const body = [`${header}${totalsSuffix}`, ...lines].join("\n");
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

	function ensureBaseline(path: string, absPath: string, beforeSnap: FileSnapshot) {
		if (!baselines.has(path)) baselines.set(path, { absPath, original: beforeSnap });
	}

	async function refreshBatchEntry(ctx: ExtensionContext, path: string): Promise<void> {
		const baseline = baselines.get(path);
		if (!baseline) return;

		const current = await readFileSnapshot(baseline.absPath);
		if (buffersEqual(baseline.original.buf, current.buf)) {
			// Back to how it was at the start of this batch - don't clutter the list.
			batch.delete(path);
			return;
		}

		const kind: BatchEntry["kind"] = baseline.original.buf === null ? "new" : current.buf === null ? "deleted" : "edited";
		const binary = baseline.original.binary || current.binary;

		let added = 0;
		let removed = 0;
		if (!binary) {
			const stats = await computeDiffStats(
				ctx.cwd,
				baseline.original.buf === null ? null : baseline.original.buf.toString("utf-8"),
				current.buf === null ? null : current.buf.toString("utf-8"),
			);
			added = stats.added;
			removed = stats.removed;
		}

		batch.set(path, { path, absPath: baseline.absPath, kind, added, removed, binary, updatedAt: Date.now() });
	}

	async function openProjectRootInVSCode(ctx: ExtensionContext): Promise<void> {
		const root = (await getRepoRoot(ctx.cwd)) ?? ctx.cwd;
		try {
			await pi.exec("code", [root]);
			if (ctx.hasUI) ctx.ui.notify(`filechanges: opened ${root} in VS Code.`, "info");
			else console.log(`[filechanges] opened ${root} in VS Code.`);
		} catch (e: any) {
			const msg = e?.message ?? String(e);
			const text = `filechanges: could not open VS Code (${msg}). Is the "code" CLI on PATH?`;
			if (ctx.hasUI) ctx.ui.notify(text, "error");
			else console.error(text);
		}
	}

	async function recordChange(ctx: ExtensionContext, path: string, absPath: string, beforeSnap: FileSnapshot): Promise<void> {
		if (awaitingFreshBatch) {
			batch.clear();
			baselines.clear();
			awaitingFreshBatch = false;
		}
		batchDirtySinceSettle = true;
		ensureBaseline(path, absPath, beforeSnap);
		await refreshBatchEntry(ctx, path);
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

	// New prompt starts: nothing to reset here by design (see header comment).
	// tool_call/tool_result below are what actually drive batch lifecycle.

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
			await recordChange(ctx, pending.path, pending.absPath, pending.before);
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

			// Resolve + filter BEFORE deciding to clear the previous batch: a bash
			// call that only touched ignored paths (e.g. `npm install` bumping
			// package-lock.json) must not wipe an unrelated, still-relevant batch.
			const patterns = getIgnorePatterns(ctx.cwd);
			const relevant: { repoRelPath: string; absPath: string; relPath: string }[] = [];
			for (const repoRelPath of touched) {
				const absPath = resolve(snap.repoRoot, repoRelPath);
				const { relPath } = normalizeToolPath(ctx.cwd, absPath);
				if (isIgnored(relPath, patterns)) continue;
				relevant.push({ repoRelPath, absPath, relPath });
			}
			if (relevant.length === 0) return;

			if (awaitingFreshBatch) {
				batch.clear();
				baselines.clear();
				awaitingFreshBatch = false;
			}

			for (const { repoRelPath, absPath, relPath } of relevant) {
				batchDirtySinceSettle = true;
				if (!baselines.has(relPath)) {
					const beforeSnap = await readGitHeadSnapshot(snap.repoRoot, repoRelPath);
					ensureBaseline(relPath, absPath, beforeSnap);
				}
				await refreshBatchEntry(ctx, relPath);
			}
			updateUi(ctx);
		}
	});

	// Print/notify a summary once pi hands control back to you, then arm the
	// "next real change retires this batch" flag. Silent (and cheap - no git
	// calls) when nothing changed since the previous settle.
	pi.on("agent_settled", async (_event, ctx) => {
		if (batchDirtySinceSettle) {
			// Final consistency sweep: catches drift from e.g. a bash command that
			// touched an already-dirty file a second time within the same batch.
			for (const path of [...baselines.keys()]) {
				await refreshBatchEntry(ctx, path);
			}
			updateUi(ctx);
			if (batch.size > 0) {
				printSummary(ctx, `Files changed (${batch.size}):`);
				persistBatch(ctx);
			}
			batchDirtySinceSettle = false;
		}
		awaitingFreshBatch = true;
	});

	pi.on("session_start", async (_event, ctx) => restoreLastBatch(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreLastBatch(ctx));

	pi.registerCommand("filechanges", {
		description: "Show files changed in the latest batch",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			updateUi(ctx);
			printSummary(ctx, `Last batch of changes (${batch.size}):`);
		},
	});

	pi.registerCommand("filechanges-clear", {
		description: "Dismiss the file-changes widget/status",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			batch.clear();
			updateUi(ctx);
			if (ctx.hasUI) ctx.ui.notify("filechanges: cleared.", "info");
			else console.log("[filechanges] cleared.");
		},
	});

	pi.registerCommand("filechanges-open", {
		description: "Open the project root in VS Code",
		handler: async (_args, ctx) => {
			await openProjectRootInVSCode(ctx);
		},
	});

	pi.registerShortcut(OPEN_VSCODE_SHORTCUT, {
		description: "Open the project root in VS Code",
		handler: async (ctx) => {
			await openProjectRootInVSCode(ctx);
		},
	});
}
