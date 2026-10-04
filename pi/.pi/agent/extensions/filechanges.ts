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
 * - Round: the Changes touched since the last agent_start (one prompt) or
 *   the last Clear. Kept as the set of paths touched; rendered by
 *   intersecting with the Session set, so a Revert drops out by itself.
 * - Mode: which scope the Panel and List show, "round" (default) or "all".
 *   Toggled by /filechanges-mode.
 * - Revert: when a file's content equals its Original again, its Change
 *   leaves the Session set automatically (content compare, not line counts)
 *   and its Original is forgotten. A reconciled file is never re-scanned at
 *   settle, so edits made outside this session (a parallel pi session, another
 *   terminal) are not attributed to it. A later touch captures a fresh
 *   Original, which also keeps that external drift out of the counts.
 *
 * Tracking:
 * - `edit`/`write` tool calls are tracked at any path, inside or outside a
 *   repo. Paths that reconcile to their Original (e.g. a `git commit` that
 *   brings a file to HEAD content) are forgotten right away, not re-scanned
 *   at every settle. `bash` changes are detected two ways: a `git status
 *   --porcelain` diff before/after each call covers the repo containing cwd, and a
 *   path-sniff of the command text covers everything else: every plausible
 *   path token is content-snapshotted pre-call and re-read post-call, with
 *   relative tokens resolved against a virtual cwd that follows `cd`. So
 *   changes in other repos and non-repo dirs still show up. Sniff limits:
 *   globs and paths constructed in code are not seen outside a repo,
 *   directories are not enumerated, and files over 10 MB are skipped.
 * - Counts come from `git diff --no-index --numstat` (no npm dependency).
 *   Binary files are detected via a NUL-byte sniff and shown as "(binary)".
 * - Noisy paths (lockfiles, node_modules, build output, .env*) are excluded
 *   by default; override via `filechanges.ignore` in `.pi/settings.json`
 *   (project) or `~/.pi/agent/settings.json` (global), project wins.
 *
 * Rendering:
 * - Panel: a persistent widget above the editor, live on every change. It
 *   shows the Mode's scope: the Round by default, the whole Session set in
 *   all mode. The header is bold and carries the scope's totals:
 *   `Changes last round (N): +A/-R` (totals hidden when both sides are zero,
 *   e.g. binary-only). One row per Change, most recently touched first,
 *   capped at 8 rows plus one trailing line (pi truncates widgets past 10
 *   lines). The trailing line is the overflow when there is one, else a
 *   pointer to the Changes the Round hides. Hidden when the Session set is
 *   empty; an empty Round with a non-empty Session set shows a one-line hint
 *   instead.
 * - Colors are semantic, from the pi theme: the kind word by meaning
 *   (created = success, modified = warning, deleted = error), the path in
 *   text, counts in toolDiffAdded/toolDiffRemoved with zero counts dimmed,
 *   `(binary)` muted. The same scheme renders in the Panel and the List.
 *   The no-UI fallback (console.log) stays plain.
 * - `/filechanges` prints the Mode's scope into the transcript (up to 30
 *   rows, then an overflow note). `/filechanges round` and `/filechanges all`
 *   print one scope without changing the Mode.
 * - `/filechanges-mode` toggles the Mode.
 * - `/filechanges-clear` empties the Session set and the Round and forgets
 *   all Originals. Tracking restarts from that point: a file edited again
 *   gets a fresh Original, so its counts are measured from the post-Clear
 *   state.
 *
 * Persistence:
 * - On `agent_settled`, the Session set, the Round, and the Mode are
 *   persisted via `pi.appendEntry()`, but only when something changed since
 *   the last settle (the dirty flag).
 * - On `session_start`/`session_tree` they are restored, so `/reload` or a
 *   resumed session doesn't blank the Panel. Entries written before the Round
 *   existed restore with the Round covering every restored Change, so the
 *   default Round view keeps showing their rows. Inside a git repo, Originals are
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
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ENTRY_SESSION_SET = "filechanges:session-set";

const PANEL_MAX_ROWS = 8;
const LIST_MAX_ROWS = 30;
const BINARY_SNIFF_BYTES = 8000;
const BASH_SNIFF_MAX_CANDIDATES = 40;
const BASH_SNIFF_MAX_BYTES = 10 * 1024 * 1024;

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

/** Which scope the Panel and List show: the Round (default) or all session changes. */
type Mode = "round" | "all";

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

type PendingBash = {
	repoRoot: string | null;
	before: Set<string>; // git porcelain paths of the cwd repo (empty when cwd is not in a repo)
	candidates: Map<string, FileSnapshot>; // command-sniffed paths anywhere on disk, pre-call content
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

/** Semantic color per Kind: color does the scannability job glyphs would, so the words stay plain. */
const KIND_COLORS: Record<Kind, string> = { created: "success", modified: "warning", deleted: "error" };

/** Shared row renderer, used by the Panel and by `/filechanges`. Plain words, no glyphs; color carries the meaning. */
function formatChangeLine(t: Change, theme?: any): string {
	const label = t.kind.padEnd(9); // "modified" is the longest kind at 8 chars
	if (!theme) return `${label}${t.path} ${countsText(t)}`;
	const prefix = theme.fg(KIND_COLORS[t.kind], label) + theme.fg("text", `${t.path} `);
	let counts: string;
	if (t.binary) {
		counts = theme.fg("muted", "(binary)");
	} else {
		const plus = t.added === 0 ? theme.fg("dim", `+${t.added}`) : theme.fg("toolDiffAdded", `+${t.added}`);
		const minus = t.removed === 0 ? theme.fg("dim", `-${t.removed}`) : theme.fg("toolDiffRemoved", `-${t.removed}`);
		counts = theme.fg("dim", "(") + plus + theme.fg("dim", "/") + minus + theme.fg("dim", ")");
	}
	return prefix + counts;
}

/** Line-count totals over one scope. Binary rows carry no counts and add nothing. */
function totalsOf(items: Change[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const t of items) {
		if (t.binary) continue;
		added += t.added;
		removed += t.removed;
	}
	return { added, removed };
}

/**
 * Panel/List header for one scope: bold label plus the scope's totals, e.g.
 * `Changes last round (3): +45/-12`. Round is the default view; "all" is the
 * whole Session set. Totals are hidden when both sides are zero (binary-only
 * scopes), leaving a bare `Changes last round (N):`.
 */
function formatHeader(mode: Mode, items: Change[], theme?: any): string {
	const base = mode === "round" ? `Changes last round (${items.length}):` : `Session changes (${items.length}):`;
	const { added, removed } = totalsOf(items);
	if (added === 0 && removed === 0) return theme ? theme.bold(base) : base;
	if (!theme) return `${base} +${added}/-${removed}`;
	const plus = added === 0 ? theme.fg("dim", `+${added}`) : theme.fg("toolDiffAdded", `+${added}`);
	const minus = removed === 0 ? theme.fg("dim", `-${removed}`) : theme.fg("toolDiffRemoved", `-${removed}`);
	return theme.bold(base) + " " + plus + theme.fg("dim", "/") + minus;
}

/**
 * Panel content for one scope: header, up to PANEL_MAX_ROWS rows, and at most
 * one trailing line (10 lines total, pi's widget limit). The trailing line is
 * the overflow when there is one, else a pointer to the Changes the Round
 * hides. Empty Round with a non-empty Session set: a one-line hint.
 */
function buildPanelLines(items: Change[], sessionSize: number, mode: Mode, theme?: any): string[] | undefined {
	if (items.length === 0) {
		if (sessionSize === 0 || mode === "all") return undefined;
		const hint = `No changes last round (${sessionSize} this session): /filechanges-mode`;
		return [theme ? theme.fg("muted", hint) : hint];
	}
	const lines: string[] = [formatHeader(mode, items, theme)];

	const shown = items.slice(0, PANEL_MAX_ROWS);
	for (const t of shown) lines.push(formatChangeLine(t, theme));
	if (items.length > shown.length) {
		const more = `…and ${items.length - shown.length} more (see /filechanges)`;
		lines.push(theme ? theme.fg("dim", more) : more);
	} else if (mode === "round" && sessionSize > items.length) {
		const more = `…and ${sessionSize - items.length} more this session (see /filechanges-mode)`;
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

/**
 * Bash path-sniffing: best-effort extraction of file paths a command might
 * touch, for change detection outside the cwd repo (where the git-status
 * diff is blind). Heuristic by design: every plausible token becomes a
 * candidate, gets content-snapshotted pre-call and re-read post-call, and
 * only real content changes are tracked. False candidates (command names,
 * flags, heredoc words) cost one failed stat each.
 */
function tokenizeBash(command: string): string[] {
	const tokens: string[] = [];
	let cur = "";
	let quote: string | null = null;
	const flush = () => {
		if (cur.length > 0) tokens.push(cur);
		cur = "";
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote !== null) {
			if (c === quote) quote = null;
			else cur += c;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			continue;
		}
		if (c === "\\" && i + 1 < command.length) {
			cur += command[++i];
			continue;
		}
		if (/\s/.test(c) || "|;&<>()".includes(c)) {
			flush();
			continue;
		}
		cur += c;
	}
	flush();
	return tokens;
}

/** Conservative filter: drop tokens that cannot be plain file paths (flags, globs, substitutions, assignments, URLs). */
function looksLikePathToken(tok: string): boolean {
	if (tok.length === 0 || tok.length > 512) return false;
	if (tok.startsWith("-")) return false;
	if (/[$`*?[\]{}()&|;<>=!#:]/.test(tok)) return false;
	return true;
}

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

/** Plausible file paths in a command, resolved against a virtual cwd that follows `cd` segments. */
function extractBashCandidates(command: string, cwd: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	let virtualCwd = cwd;
	let expectCdTarget = false;
	for (const tok of tokenizeBash(command)) {
		if (expectCdTarget) {
			expectCdTarget = false;
			if (looksLikePathToken(tok)) virtualCwd = resolve(virtualCwd, expandHome(tok));
			continue;
		}
		if (tok === "cd") {
			expectCdTarget = true;
			continue;
		}
		if (!looksLikePathToken(tok)) continue;
		const abs = resolve(virtualCwd, expandHome(tok));
		if (seen.has(abs)) continue;
		seen.add(abs);
		out.push(abs);
		if (out.length >= BASH_SNIFF_MAX_CANDIDATES) break;
	}
	return out;
}

/** Content snapshot for a sniffed candidate. Regular files only, capped in size; anything else reads as absent. */
async function readCandidateSnapshot(absPath: string): Promise<FileSnapshot> {
	try {
		const st = await stat(absPath);
		if (!st.isFile() || st.size > BASH_SNIFF_MAX_BYTES) return { buf: null, binary: false };
		const buf = await readFile(absPath);
		return { buf, binary: isBinaryBuffer(buf) };
	} catch {
		return { buf: null, binary: false };
	}
}

export default function (pi: ExtensionAPI) {
	// The Session set: every Change since session start or the last Clear.
	// Accumulates across prompts; never resets on its own.
	const sessionSet = new Map<string, Change>();
	// The Round: display paths touched since the last agent_start (one prompt)
	// or Clear. Rendered by intersecting with the Session set, so a Revert
	// drops out by itself. The settle sweep does not add to it: still-diverged
	// files from earlier rounds stay out of the current one.
	const roundPaths = new Set<string>();
	// The current view scope. Round is the default; persisted with the set.
	let mode: Mode = "round";
	// One Original per touched file, captured at first touch. Later touches of
	// the same file compare against it, so no-op tool calls don't erase real
	// changes and counts stay measured from the session's perspective. An
	// Original is forgotten as soon as the file reconciles to it (Revert), so
	// the settle sweep never hoists external edits to reconciled files (e.g.
	// from a parallel session) into this session's set.
	const originals = new Map<string, Original>();
	const pendingByToolCallId = new Map<string, PendingSnapshot>();
	const pendingBashSnapshots = new Map<string, PendingBash>();

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

	/** Changes in one scope, most recently touched first. */
	function changesIn(view: Mode): Change[] {
		const items = [...sessionSet.values()].sort((a, b) => b.updatedAt - a.updatedAt);
		return view === "round" ? items.filter((c) => roundPaths.has(c.path)) : items;
	}

	function updateUi(ctx: ExtensionContext) {
		if (!ctx?.hasUI) return;
		ctx.ui.setWidget("filechanges", buildPanelLines(changesIn(mode), sessionSet.size, mode, ctx.ui.theme));
	}

	function persistSessionSet() {
		pi.appendEntry(ENTRY_SESSION_SET, { items: [...sessionSet.values()], round: [...roundPaths], mode, timestamp: Date.now() });
	}

	async function restoreSessionSet(ctx: ExtensionContext) {
		let data: any = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_SESSION_SET) data = entry.data;
		}
		sessionSet.clear();
		originals.clear();
		roundPaths.clear();
		if (data?.items && Array.isArray(data.items)) {
			for (const item of data.items) {
				const change = sanitizeRestored(item);
				if (change) sessionSet.set(change.path, change);
			}
		}
		mode = data?.mode === "all" ? "all" : "round";
		// Entries from before the Round existed carry no `round`: cover every
		// restored Change, so the default Round view keeps showing their rows.
		const restoredRound: unknown[] = Array.isArray(data?.round) ? data.round : [...sessionSet.keys()];
		for (const p of restoredRound) if (typeof p === "string") roundPaths.add(p);
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

	/** `/filechanges`: print one scope into the transcript, colored like the Panel. A `round`/`all` arg picks a scope once without changing the Mode. */
	function listSessionSet(ctx: ExtensionContext, args: string) {
		const arg = args.trim();
		const view: Mode = arg === "all" || arg === "round" ? arg : mode;
		const items = changesIn(view);
		if (items.length === 0) {
			const msg =
				view === "round" && sessionSet.size > 0
					? `filechanges: no changes last round (${sessionSet.size} this session: /filechanges-mode).`
					: "filechanges: no files changed this session.";
			if (ctx.hasUI) ctx.ui.notify(msg, "info");
			else console.log(`[filechanges] ${msg}`);
			return;
		}
		const theme = ctx.hasUI ? ctx.ui.theme : undefined;
		const shown = items.slice(0, LIST_MAX_ROWS);
		const lines = [formatHeader(view, items, theme), ...shown.map((t) => formatChangeLine(t, theme))];
		if (items.length > shown.length) {
			const more = `  …and ${items.length - shown.length} more`;
			lines.push(theme ? theme.fg("dim", more) : more);
		} else if (view === "round" && sessionSet.size > items.length) {
			const more = `  …and ${sessionSet.size - items.length} more this session (see /filechanges-mode)`;
			lines.push(theme ? theme.fg("dim", more) : more);
		}
		const body = lines.join("\n");
		if (ctx.hasUI) ctx.ui.notify(body, "info");
		else console.log(`[filechanges] ${body}`);
	}

	/** Flip the Mode and persist it so a /reload keeps the chosen view. */
	function toggleMode(ctx: ExtensionContext) {
		mode = mode === "round" ? "all" : "round";
		updateUi(ctx);
		persistSessionSet();
		const msg = mode === "round" ? "filechanges: showing changes last round." : "filechanges: showing all session changes.";
		if (ctx.hasUI) ctx.ui.notify(msg, "info");
		else console.log(`[filechanges] ${msg}`);
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
			// Revert: back to its Original. Drop the Change AND forget the Original.
			// Keeping a stale Original would re-scan the file at every future settle
			// and attribute external edits (parallel sessions, other terminals) to
			// this session; a later touch captures a fresh Original instead.
			sessionSet.delete(path);
			originals.delete(path);
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
		roundPaths.add(path);
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

	// Capture before-snapshots for edit/write calls. For bash calls, capture
	// both a git-status snapshot of the cwd repo and content snapshots of the
	// command's sniffed path tokens (covers changes outside that repo).
	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
			const { absPath, relPath } = normalizeToolPath(ctx.cwd, (event.input as any).path);
			if (isIgnored(relPath, getIgnorePatterns(ctx.cwd))) return;
			const before = await readFileSnapshot(absPath);
			pendingByToolCallId.set(event.toolCallId, { path: relPath, absPath, before });
			return;
		}
		if (isToolCallEventType("bash", event)) {
			const input = event.input as any;
			const command = typeof input?.command === "string" ? input.command : "";
			const realCwd = await getRealCwd(ctx.cwd);
			const repoRoot = await getRepoRoot(ctx.cwd);
			const before = repoRoot ? await snapshotGitStatus(repoRoot) : new Set<string>();
			const candidates = new Map<string, FileSnapshot>();
			await Promise.all(
				extractBashCandidates(command, realCwd).map(async (absPath) => {
					candidates.set(absPath, await readCandidateSnapshot(absPath));
				}),
			);
			pendingBashSnapshots.set(event.toolCallId, { repoRoot, before, candidates });
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
			if (!snap) return; // wasn't captured (e.g. errored before tool_call ran)

			const patterns = getIgnorePatterns(ctx.cwd);
			const realCwd = await getRealCwd(ctx.cwd);

			// Command-sniffed paths, tracked at any location, in or out of the
			// cwd repo. Runs before the git diff so the pre-call content wins as
			// the Original when both mechanisms see the same file.
			for (const [absPath, beforeSnap] of snap.candidates) {
				const afterSnap = await readCandidateSnapshot(absPath);
				if (buffersEqual(beforeSnap.buf, afterSnap.buf)) continue;
				const { relPath } = normalizeToolPath(realCwd, absPath);
				if (isIgnored(relPath, patterns)) continue;
				await trackChange(ctx, relPath, absPath, beforeSnap);
			}

			const repoRoot = snap.repoRoot;
			if (!repoRoot) return; // cwd not in a repo: the sniff was the only detection

			const after = await snapshotGitStatus(repoRoot);
			const touched = new Set<string>();
			for (const p of snap.before) if (!after.has(p)) touched.add(p);
			for (const p of after) if (!snap.before.has(p)) touched.add(p);
			if (touched.size === 0) return;

			// Resolve and filter BEFORE tracking: a bash call that only touched
			// ignored paths (e.g. `npm install` bumping package-lock.json) must not
			// mark the Session set dirty or surface irrelevant rows.
			const relevant: { repoRelPath: string; absPath: string; relPath: string }[] = [];
			for (const repoRelPath of touched) {
				const absPath = resolve(repoRoot, repoRelPath);
				const { relPath } = normalizeToolPath(realCwd, absPath);
				if (isIgnored(relPath, patterns)) continue;
				relevant.push({ repoRelPath, absPath, relPath });
			}
			if (relevant.length === 0) return;

			for (const { repoRelPath, absPath, relPath } of relevant) {
				dirtySinceSettle = true;
				roundPaths.add(relPath);
				if (!originals.has(relPath)) {
					const beforeSnap = await readGitHeadSnapshot(repoRoot, repoRelPath);
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
		// Only still-diverged files hold an Original at this point (reconciled
		// ones were forgotten), so the sweep can't pull in external edits to
		// files this session is done with.
		for (const path of [...originals.keys()]) {
			await refreshChange(ctx, path);
		}
		dirtySinceSettle = false;
		updateUi(ctx);
		// Persist even when the sweep reverted every Change: the empty entry
		// overwrites earlier ones so a reload doesn't resurrect stale rows.
		persistSessionSet();
	});

	// A new prompt starts a new Round: the Panel switches to the changes this
	// prompt produces. The Session set is untouched (all mode still shows it).
	pi.on("agent_start", async (_event, ctx) => {
		roundPaths.clear();
		updateUi(ctx);
	});

	pi.on("session_start", async (_event, ctx) => restoreSessionSet(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreSessionSet(ctx));

	pi.registerCommand("filechanges", {
		description: "List changed files for the current view (append 'round' or 'all' to pick a view once)",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			updateUi(ctx);
			listSessionSet(ctx, args);
		},
	});

	pi.registerCommand("filechanges-mode", {
		description: "Toggle the filechanges view between the last round and all session changes",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			toggleMode(ctx);
		},
	});


	pi.registerCommand("filechanges-clear", {
		description: "Clear the session change list and restart tracking",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			sessionSet.clear();
			originals.clear();
			roundPaths.clear();
			dirtySinceSettle = false;
			updateUi(ctx);
			// Persist the empty set so a /reload doesn't resurrect the cleared list.
			persistSessionSet();
			if (ctx.hasUI) ctx.ui.notify("filechanges: cleared. Tracking restarts from the next change.", "info");
			else console.log("[filechanges] cleared.");
		},
	});
}
