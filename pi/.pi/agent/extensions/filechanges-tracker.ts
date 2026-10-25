/**
 * filechanges-tracker.ts — shared, per-session file-change tracking state.
 *
 * Extracted from filechanges.ts, which keeps only the widget rendering and
 * the /filechanges* commands. Vocabulary: docs/filechanges-design.md
 * (Original, Change, Session set, Round, Mode, Repo state, Revert).
 *
 * Sharing model: extensions cannot share state through plain imports here.
 * pi loads every extension through its own jiti instance with
 * `moduleCache: false`, so two extensions importing this file each get their
 * own module copy. The only cross-module channel that survives that is
 * globalThis: the tracker registry lives under a Symbol.for key, the same
 * pattern layout-manager.ts uses for the layout-root slot.
 *
 * Session keying (per-session isolation): the registry maps one session to
 * one tracker. The key is the session identity from ctx.sessionManager: the
 * stable session id string when the manager exposes getSessionId(), else the
 * sessionManager object's own identity (pi's ReadonlySessionManager always
 * has getSessionId; the object fallback covers mock harnesses and any
 * context without it). In-process subagent child sessions get their own
 * sessionManager and session id, so they can never reach the main session's
 * tracker, and the main session can never reach theirs. Each tracker
 * re-binds the key on every event (an idempotent Map.set), so the newest
 * tracker for a session always wins the entry: a tracker left in the
 * registry by a pre-/reload generation is replaced the moment the fresh
 * one sees its first event.
 *
 * Creation timing: pi snapshots each event's handler list before dispatch
 * (snapshotEventHandlers in the extension runner), so a tracker created
 * lazily inside a first event handler would not receive that same event
 * through its own subscription (it would miss the session_start restore or
 * a tool_call before-snapshot). filechanges.ts therefore creates the
 * tracker eagerly at extension-factory time, when no ctx exists yet: the
 * tracker wires its events immediately and binds to the session key on its
 * first event. Until then it parks in the registry's `pending` slot, which
 * a lookup WITH ctx adopts instead of wiring a second tracker (this covers
 * an extension whose load order sorts before filechanges.ts looking the
 * tracker up during the first event dispatch).
 *
 * /reload continuity: unchanged from the pre-split extension. The Session
 * set, the Round, and the Mode persist via pi.appendEntry on agent_settled
 * (only when dirty) and restore on session_start/session_tree, so a fresh
 * module instance after /reload restores exactly like the old extension
 * did. Repo state is never persisted; restore recomputes it from git.
 *
 * pi auto-discovers every *.ts file in this directory as an extension and
 * requires a default factory export, so this module exports a no-op one
 * (same pattern as layout-manager.ts). The default export must NOT create
 * a tracker: creation happens only through getSharedFileChangesTracker, so
 * exactly one extension load per session wires the six event
 * subscriptions. If this module's factory created a tracker too, the
 * filechanges.ts factory would create a second one and every event would
 * be tracked twice.
 *
 * Consumers:
 * - filechanges.ts: the above-editor Panel and the /filechanges* commands.
 *   Subscribes for widget refreshes. Another consumer can hide the Panel
 *   with setWidgetSuppressed(true), so nothing is shown twice.
 *   No current consumer sets it; the split-view panel is retired.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isBashToolResult, isEditToolResult, isToolCallEventType, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ENTRY_SESSION_SET = "filechanges:session-set";

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
	"*.tmp",
	"*.temp",
	"*~",
	"*.swp",
	"*.swo",
	".#*",
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

/**
 * Repo state: the file's git status as one plain word. Derived from
 * `git status --porcelain -z` XY codes: `??` = untracked, X set = staged
 * (something is in the index; `MM` included, there is no "partially
 * staged"), Y-only = unstaged, unmerged = conflicted. Absent from porcelain:
 * committed when `git ls-files` tracks the path, no state otherwise (ignored
 * files, so the word never lies). Undefined for files outside any repo.
 */
type RepoState = "untracked" | "staged" | "unstaged" | "conflicted" | "committed";

/** Which scope the Panel and List show: the Round (default) or all session changes. */
export type Mode = "round" | "all";

/**
 * Semantic theme-key per Kind, shared by every renderer of tracker state
 * (the filechanges.ts Panel/List). Color does the scannability job glyphs
 * would, so the words stay
 * plain: created = success, modified = warning, deleted = error.
 */
export const KIND_COLORS: Record<Kind, string> = {
	created: "success",
	modified: "warning",
	deleted: "error",
};

/**
 * Semantic theme-key per Repo state, shared by every renderer of tracker
 * state. The state axis stays quiet metadata so it cannot clash with the
 * kind hues on the same row: accent marks "in the index" (staged),
 * committed is dim (done), untracked and unstaged are muted (normal work
 * states, no alarm), and conflicted is the only state red is spent on.
 * Warning is deliberately unused here: the normal work state must not
 * render as an alarm, and a `modified ... unstaged` row must not read
 * yellow-yellow.
 */
export const REPO_STATE_COLORS: Record<RepoState, string> = {
	untracked: "muted",
	staged: "accent",
	unstaged: "muted",
	conflicted: "error",
	committed: "dim",
};

/**
 * Map a porcelain XY code to a Repo state. `tracked` (from `git ls-files`)
 * decides what porcelain silence means: absent and tracked = committed,
 * absent and untracked = no state (git does not know the file).
 */
function repoStateFromXY(xy: string | undefined, tracked: boolean): RepoState | undefined {
	if (xy === undefined) return tracked ? "committed" : undefined;
	if (xy === "??") return "untracked";
	const x = xy[0];
	const y = xy[1];
	if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflicted";
	if (x !== " ") return "staged";
	return "unstaged";
}

/**
 * One file whose current content differs from its Original. Public shape of
 * a tracked Change, as the Panel and the List render it.
 * `absolutePath` is an alias of `absPath` (same value) kept for consumers
 * that read that name; the persisted entry and the tracker
 * internals keep using `absPath`, so the session-log format is unchanged.
 */
export interface FileChange {
	path: string; // display path, relative to ctx.cwd where possible
	absPath: string;
	absolutePath: string; // alias of absPath (see above)
	kind: Kind;
	added: number;
	removed: number;
	binary: boolean;
	updatedAt: number;
	repoState?: RepoState; // git status word; undefined outside a repo and for git-ignored files
}

/** Internal stored shape: the pre-split Change type, unchanged. */
type TrackedChange = Omit<FileChange, "absolutePath">;

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

// --- tmp path filtering ---

// Files under the OS temp dirs are never reviewable output: throwaway
// scripts, captures, editor temp files. Checked at every tracking entry
// point before any snapshotting, so they cost no content reads and never
// leave an Original behind. macOS tmpdir is a per-user confstr path and
// /tmp is a symlink to /private/tmp, so both the resolved and the real
// (symlink-free) forms are matched.
let tmpRoots: string[] | null = null; // computed once, on first use
let tmpRootsOverride: string[] | null = null; // test seam: __setTmpRootsForTest

/** Each root in both its logical and its realpath form (macOS: /tmp vs /private/tmp, /var vs /private/var). */
function expandRoots(roots: Iterable<string>): string[] {
	const out = new Set<string>();
	for (const r of roots) {
		out.add(r);
		try {
			out.add(realpathSync(r));
		} catch {
			// does not exist (yet): keep the logical form only
		}
	}
	return [...out];
}

function getTmpRoots(): string[] {
	if (tmpRootsOverride) return tmpRootsOverride;
	if (!tmpRoots) tmpRoots = expandRoots([resolve(tmpdir()), "/tmp", "/private/tmp", "/var/tmp"]);
	return tmpRoots;
}

function underRoot(p: string, root: string): boolean {
	return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Realpath of the file itself, or of its nearest existing ancestor when it does not exist yet. */
function nearestRealPath(p: string): string {
	let cur = resolve(p);
	for (;;) {
		try {
			return realpathSync(cur);
		} catch {
			const parent = dirname(cur);
			if (parent === cur) return cur;
			cur = parent;
		}
	}
}

/** True when the path lives in an OS temp dir (both path forms against both root forms). */
function isTmpPath(absPath: string): boolean {
	const p = resolve(absPath);
	const real = nearestRealPath(p);
	const forms = real === p ? [p] : [p, real];
	for (const form of forms) for (const root of getTmpRoots()) if (underRoot(form, root)) return true;
	return false;
}

/** Test seam: point the tmp check at fixture dirs instead of the real tmpdir. Pass null to restore. */
export function __setTmpRootsForTest(roots: string[] | null): void {
	tmpRootsOverride = roots ? expandRoots(roots) : null;
}

function sanitizeRestored(item: any): TrackedChange | null {
	if (!item || typeof item.path !== "string" || typeof item.absPath !== "string") return null;
	if (isTmpPath(item.absPath)) return null;
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

// --- shared-instance registry ---

interface TrackerRegistry {
	/** One tracker per session (keyed by sessionKeyOf). Re-binding on every event keeps the newest generation winning. */
	bySession: Map<unknown, FileChangesTracker>;
	/** Tracker created at extension-factory time (no ctx exists yet), not yet bound to a session key. */
	pending: FileChangesTracker | null;
}

// globalThis is the one channel that survives pi's per-extension jiti module
// copies (moduleCache: false); see the header. Symbol.for, like layout-manager.ts.
const REGISTRY_KEY = Symbol.for("pi.filechanges.tracker");
const G = globalThis as Record<symbol, TrackerRegistry>;
const registry: TrackerRegistry = (G[REGISTRY_KEY] ??= { bySession: new Map(), pending: null });

/**
 * Session identity for the shared-instance registry: the stable session id
 * string from ctx.sessionManager when it exposes getSessionId(), else the
 * sessionManager object itself (identity). In-process subagent child
 * sessions get their own manager and id, so they always key apart from the
 * main session and from each other.
 */
function sessionKeyOf(ctx: ExtensionContext): unknown {
	const sm = (ctx as any)?.sessionManager;
	if (sm && typeof sm.getSessionId === "function") {
		try {
			return `session:${sm.getSessionId()}`;
		} catch {
			// fall back to manager identity
		}
	}
	return sm ?? ctx;
}

/** The tracker contract for consumers (filechanges.ts widget and commands). */
export interface FileChangesTracker {
	/** Changes in one scope, most recently touched first. Defaults to the current Mode. */
	getChanges(mode?: Mode): FileChange[];
	getMode(): Mode;
	/** Set the Mode and persist it, so a /reload keeps the chosen view. */
	setMode(mode: Mode): void;
	/** /filechanges-clear semantics: empty the Session set and the Round, forget all Originals, persist the empty state. Tracking restarts from the next change. */
	clear(): void;
	/**
	 * The session Original for a display path: the content captured at first
	 * touch, for diffing original vs. current. Undefined when the path was
	 * never touched (or was reconciled away). A created file's Original has
	 * empty content; binary Originals are returned decoded as-is.
	 */
	getOriginal(path: string): { content: string } | undefined;
	/** Fire on every state change (tracking, revert, Round reset, restore, mode, clear, suppression). Returns unsubscribe. */
	subscribe(cb: () => void): () => void;
	/**
	 * When true, filechanges.ts keeps tracking but stops rendering the
	 * above-editor widget (and clears it via ctx.ui.setWidget with
	 * undefined), so another consumer can own presentation
	 * without anything being shown twice. Default false.
	 */
	setWidgetSuppressed(suppressed: boolean): void;
	isWidgetSuppressed(): boolean;
	/**
	 * Recompute every Change's Repo state (one git status + ls-files per
	 * repo); true when any state changed. A manual refresh point for
	 * /filechanges. Uses the ctx of the most recent
	 * event when none is passed.
	 */
	refreshRepoStates(ctx?: ExtensionContext): Promise<boolean>;
	/** The ExtensionContext of the most recent event (for consumers that need ctx.ui). Null before the first event. */
	getContext(): ExtensionContext | null;
}

/**
 * THE one tracker for the current session. First call creates it and wires
 * its event subscriptions (tool_call, tool_result, agent_start,
 * agent_settled, session_start, session_tree); later calls from other
 * extensions in the same session return the same instance, never duplicate
 * event wiring. Pass ctx whenever one is available (event handlers,
 * commands): the call then resolves the session key and dedupes through
 * the registry. Without ctx (extension-factory time, before any event),
 * the tracker is created and wired immediately so its subscriptions
 * precede the first event, and parks in the registry's `pending` slot
 * until its first event binds the session key.
 */
export function getSharedFileChangesTracker(pi: ExtensionAPI, ctx?: ExtensionContext): FileChangesTracker {
	if (ctx) {
		const key = sessionKeyOf(ctx);
		const existing = registry.bySession.get(key);
		if (existing) return existing;
		// A tracker created at factory time (filechanges.ts) that has not
		// seen an event yet: adopt it instead of wiring a second one.
		const pending = registry.pending;
		if (pending) {
			registry.pending = null;
			registry.bySession.set(key, pending);
			return pending;
		}
		// No tracker for this session (e.g. filechanges.ts is not
		// installed). Creating during an event dispatch means this
		// tracker's own handlers first fire from the NEXT event; the
		// current one is missed. Acceptable fallback, documented.
		const created = createTracker(pi);
		registry.bySession.set(key, created);
		return created;
	}
	// Factory time: create and wire now (before any event), park as pending.
	const tracker = createTracker(pi);
	registry.pending = tracker;
	return tracker;
}

function createTracker(pi: ExtensionAPI): FileChangesTracker {
	// The Session set: every Change since session start or the last Clear.
	// Accumulates across prompts; never resets on its own.
	const sessionSet = new Map<string, TrackedChange>();
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
	// Repo root per file directory, for tracked files outside the cwd repo.
	const fileRepoRootCache = new Map<string, string | null>();

	// Consumer plumbing: every state change fires the subscribers (the
	// filechanges.ts widget refresh). A broken
	// subscriber must never break tracking, so errors are swallowed.
	const subscribers = new Set<() => void>();
	let widgetSuppressed = false;
	// The ctx of the most recent event: binding key, and the ctx consumers
	// paint with when a state change fires their subscription.
	let lastEventCtx: ExtensionContext | null = null;

	function notifySubscribers(): void {
		for (const cb of [...subscribers]) {
			try {
				cb();
			} catch {
				// a broken subscriber must never break tracking
			}
		}
	}

	/**
	 * Bind this tracker to the current session key (idempotent Map.set, so
	 * the newest generation for a session always wins the registry entry,
	 * e.g. after /reload) and remember the event ctx for consumers.
	 */
	function bindToSession(ctx: ExtensionContext | undefined): void {
		if (!ctx) return;
		lastEventCtx = ctx;
		registry.bySession.set(sessionKeyOf(ctx), api);
		if (registry.pending === api) registry.pending = null;
	}

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

	/** Changes in one scope, most recently touched first (the ordering the Panel uses). */
	function getChanges(view?: Mode): FileChange[] {
		const items = [...sessionSet.values()].sort((a, b) => b.updatedAt - a.updatedAt);
		const scoped = (view ?? mode) === "round" ? items.filter((c) => roundPaths.has(c.path)) : items;
		// Copies with the absolutePath alias; the stored objects stay the
		// pre-split shape so persistence is byte-identical.
		return scoped.map((c) => ({ ...c, absolutePath: c.absPath }));
	}

	function persistSessionSet() {
		// Repo state is display-only and recomputed on restore, so it is stripped here.
		const items = [...sessionSet.values()].map(({ repoState, ...rest }) => rest);
		pi.appendEntry(ENTRY_SESSION_SET, { items, round: [...roundPaths], mode, timestamp: Date.now() });
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
		// Repo state is not persisted; recompute it from git on restore.
		await refreshRepoStates(ctx);
		dirtySinceSettle = false;
		notifySubscribers();
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
		// Backstop: tmp files are filtered at every entry point, but nothing
		// may ever be tracked (or leave an Original) for them.
		if (isTmpPath(absPath)) return;
		dirtySinceSettle = true;
		roundPaths.add(path);
		ensureOriginal(path, absPath, beforeSnap);
		await refreshChange(ctx, path);
		notifySubscribers();
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
	// The XY code is kept per path: bash change detection diffs the key sets,
	// Repo state reads the codes.
	function parsePorcelainZ(stdout: string): Map<string, string> {
		const statuses = new Map<string, string>(); // repo-relative path -> XY
		const tokens = stdout.split("\0").filter((t) => t.length > 0);
		let i = 0;
		while (i < tokens.length) {
			const entry = tokens[i];
			const xy = entry.slice(0, 2);
			const statusX = entry[0];
			const statusY = entry[1];
			statuses.set(entry.slice(3), xy);
			if (statusX === "R" || statusX === "C" || statusY === "R" || statusY === "C") {
				i++;
				if (i < tokens.length) statuses.set(tokens[i], xy);
			}
			i++;
		}
		return statuses;
	}

	async function snapshotGitStatus(repoRoot: string): Promise<Map<string, string>> {
		try {
			const res = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
				cwd: repoRoot,
				maxBuffer: 10 * 1024 * 1024,
			});
			return parsePorcelainZ(res.stdout);
		} catch (e: any) {
			if (e?.code === "ENOENT") gitAvailable = false;
			return new Map();
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

	// --- Repo state (git status annotation) ---

	/** Repo root containing a file, cached per directory. Files outside any repo (or in deleted dirs) get null. */
	async function getRepoRootForFile(absPath: string): Promise<string | null> {
		const dir = dirname(absPath);
		const cached = fileRepoRootCache.get(dir);
		if (cached !== undefined) return cached;
		let root: string | null = null;
		if (gitAvailable) {
			try {
				const res = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
				root = res.stdout.trim() || null;
			} catch (e: any) {
				if (e?.code === "ENOENT") gitAvailable = false;
			}
		}
		fileRepoRootCache.set(dir, root);
		return root;
	}

	/** Canonical absolute path for containment checks and repo-relative paths (git reports resolved paths), even for deleted files. */
	async function resolveExistingPath(absPath: string): Promise<string> {
		try {
			return await realpath(absPath);
		} catch {
			try {
				return join(await realpath(dirname(absPath)), basename(absPath));
			} catch {
				return absPath;
			}
		}
	}

	/** Paths git tracks in a repo (`git ls-files`): decides what porcelain silence means for Repo state. */
	async function listTrackedFiles(repoRoot: string): Promise<Set<string>> {
		try {
			const res = await execFileAsync("git", ["ls-files", "-z"], { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 });
			return new Set(res.stdout.split("\0").filter((p) => p.length > 0));
		} catch (e: any) {
			if (e?.code === "ENOENT") gitAvailable = false;
			return new Set();
		}
	}

	/**
	 * Recompute every Change's Repo state: group the Session set by repo, then
	 * one `git status --porcelain -z` + `git ls-files -z` per repo. `known`
	 * reuses a porcelain snapshot the caller already took (bash detection), so
	 * that repo's status call is skipped. Files in the cwd repo are matched by
	 * containment; files elsewhere resolve their own repo root. Returns true
	 * when any state changed. Called on agent_start, agent_settled, bash
	 * results, restore, and /filechanges (not on edit/write results: a row can
	 * lack the word mid-round and the settle fixes it).
	 */
	async function refreshRepoStates(ctx: ExtensionContext | undefined, known?: { repoRoot: string; statuses: Map<string, string> }): Promise<boolean> {
		if (!ctx || sessionSet.size === 0 || !gitAvailable) return false;
		const cwdRoot = await getRepoRoot(ctx.cwd);
		const byRepo = new Map<string, { change: TrackedChange; rel: string }[]>();
		let changed = false;
		for (const change of sessionSet.values()) {
			const realAbs = await resolveExistingPath(change.absPath);
			let root: string | null = null;
			if (cwdRoot) {
				const rel = relative(cwdRoot, realAbs);
				if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) root = cwdRoot;
			}
			if (!root) root = await getRepoRootForFile(realAbs);
			if (!root) {
				if (change.repoState !== undefined) {
					change.repoState = undefined;
					changed = true;
				}
				continue;
			}
			const rel = relative(root, realAbs).split(sep).join("/");
			const list = byRepo.get(root) ?? [];
			if (list.length === 0) byRepo.set(root, list);
			list.push({ change, rel });
		}
		for (const [root, entries] of byRepo) {
			const statuses = known && root === known.repoRoot ? known.statuses : await snapshotGitStatus(root);
			const tracked = await listTrackedFiles(root);
			for (const { change, rel } of entries) {
				const next = repoStateFromXY(statuses.get(rel), tracked.has(rel));
				if (change.repoState !== next) {
					change.repoState = next;
					changed = true;
				}
			}
		}
		return changed;
	}

	// Capture before-snapshots for edit/write calls. For bash calls, capture
	// both a git-status snapshot of the cwd repo and content snapshots of the
	// command's sniffed path tokens (covers changes outside that repo).
	pi.on("tool_call", async (event, ctx) => {
		bindToSession(ctx);
		if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
			const { absPath, relPath } = normalizeToolPath(ctx.cwd, (event.input as any).path);
			if (isIgnored(relPath, getIgnorePatterns(ctx.cwd)) || isTmpPath(absPath)) return;
			const before = await readFileSnapshot(absPath);
			pendingByToolCallId.set(event.toolCallId, { path: relPath, absPath, before });
			return;
		}
		if (isToolCallEventType("bash", event)) {
			const input = event.input as any;
			const command = typeof input?.command === "string" ? input.command : "";
			const realCwd = await getRealCwd(ctx.cwd);
			const repoRoot = await getRepoRoot(ctx.cwd);
			const beforeMap = repoRoot ? await snapshotGitStatus(repoRoot) : new Map<string, string>();
			const candidates = new Map<string, FileSnapshot>();
			await Promise.all(
				extractBashCandidates(command, realCwd)
					.filter((absPath) => !isTmpPath(absPath))
					.map(async (absPath) => {
						candidates.set(absPath, await readCandidateSnapshot(absPath));
				}),
			);
			pendingBashSnapshots.set(event.toolCallId, { repoRoot, before: new Set(beforeMap.keys()), candidates });
		}
	});

	// Commit on successful results.
	pi.on("tool_result", async (event, ctx) => {
		bindToSession(ctx);
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
				if (isTmpPath(absPath)) continue; // defense in depth: capture already filters
				const afterSnap = await readCandidateSnapshot(absPath);
				if (buffersEqual(beforeSnap.buf, afterSnap.buf)) continue;
				const { relPath } = normalizeToolPath(realCwd, absPath);
				if (isIgnored(relPath, patterns)) continue;
				await trackChange(ctx, relPath, absPath, beforeSnap);
			}

			const repoRoot = snap.repoRoot;
			if (!repoRoot) return; // cwd not in a repo: the sniff was the only detection

			const after = await snapshotGitStatus(repoRoot); // repo-relative path -> porcelain XY
			const afterPaths = new Set(after.keys());
			const touched = new Set<string>();
			for (const p of snap.before) if (!afterPaths.has(p)) touched.add(p);
			for (const p of afterPaths) if (!snap.before.has(p)) touched.add(p);

			if (touched.size > 0) {
				// Resolve and filter BEFORE tracking: a bash call that only touched
				// ignored paths (e.g. `npm install` bumping package-lock.json) must not
				// mark the Session set dirty or surface irrelevant rows.
				const relevant: { repoRelPath: string; absPath: string; relPath: string }[] = [];
				for (const repoRelPath of touched) {
					const absPath = resolve(repoRoot, repoRelPath);
					if (isTmpPath(absPath)) continue;
					const { relPath } = normalizeToolPath(realCwd, absPath);
					if (isIgnored(relPath, patterns)) continue;
					relevant.push({ repoRelPath, absPath, relPath });
				}
				for (const { repoRelPath, absPath, relPath } of relevant) {
					dirtySinceSettle = true;
					roundPaths.add(relPath);
					if (!originals.has(relPath)) {
						const beforeSnap = await readGitHeadSnapshot(repoRoot, repoRelPath);
						ensureOriginal(relPath, absPath, beforeSnap);
					}
					await refreshChange(ctx, relPath);
				}
			}

			// Repo states move even when content does not (`git add` / `git commit`
			// flip only the index, leaving the porcelain path set unchanged), so
			// refresh them off the after-snapshot and repaint when either content
			// or state changed.
			const statesChanged = await refreshRepoStates(ctx, { repoRoot, statuses: after });
			if (touched.size > 0 || statesChanged) notifySubscribers();
		}
	});

	// Once pi hands control back: reconcile every tracked file, refresh the
	// Panel, and persist (cheap no-op when nothing changed since the last settle).
	pi.on("agent_settled", async (_event, ctx) => {
		bindToSession(ctx);
		if (!dirtySinceSettle) return;
		// Final consistency sweep: catches drift from e.g. a bash command that
		// touched an already-tracked file a second time within the same turn.
		// Only still-diverged files hold an Original at this point (reconciled
		// ones were forgotten), so the sweep can't pull in external edits to
		// files this session is done with.
		for (const path of [...originals.keys()]) {
			await refreshChange(ctx, path);
		}
		await refreshRepoStates(ctx);
		dirtySinceSettle = false;
		notifySubscribers();
		// Persist even when the sweep reverted every Change: the empty entry
		// overwrites earlier ones so a reload doesn't resurrect stale rows.
		persistSessionSet();
	});

	// A new prompt starts a new Round: the Panel switches to the changes this
	// prompt produces. The Session set is untouched (all mode still shows it).
	pi.on("agent_start", async (_event, ctx) => {
		bindToSession(ctx);
		roundPaths.clear();
		// Staging/committing between prompts (e.g. in VS Code) is picked up here.
		await refreshRepoStates(ctx);
		notifySubscribers();
	});

	pi.on("session_start", async (_event, ctx) => {
		bindToSession(ctx);
		await restoreSessionSet(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		bindToSession(ctx);
		await restoreSessionSet(ctx);
	});

	const api: FileChangesTracker = {
		getChanges,
		getMode: () => mode,
		setMode(next: Mode) {
			mode = next;
			notifySubscribers();
			persistSessionSet();
		},
		clear() {
			sessionSet.clear();
			originals.clear();
			roundPaths.clear();
			dirtySinceSettle = false;
			notifySubscribers();
			// Persist the empty set so a /reload doesn't resurrect the cleared list.
			persistSessionSet();
		},
		getOriginal(path: string) {
			const original = originals.get(path);
			if (!original) return undefined;
			return { content: original.snapshot.buf?.toString("utf-8") ?? "" };
		},
		subscribe(cb: () => void) {
			subscribers.add(cb);
			return () => {
				subscribers.delete(cb);
			};
		},
		setWidgetSuppressed(suppressed: boolean) {
			if (widgetSuppressed === suppressed) return;
			widgetSuppressed = suppressed;
			// The widget owner reacts in its subscription: clear on suppress,
			// repaint on restore. Tracking is unaffected either way.
			notifySubscribers();
		},
		isWidgetSuppressed: () => widgetSuppressed,
		refreshRepoStates: (ctx?: ExtensionContext) => refreshRepoStates(ctx ?? lastEventCtx ?? undefined),
		getContext: () => lastEventCtx,
	};
	return api;
}

/**
 * This module is a shared utility imported by filechanges.ts (and, through
 * it, by nothing else directly). pi auto-discovers
 * every *.ts file in this directory as an extension and requires a default
 * factory export, so expose a no-op one here. The named exports above are
 * what the other extensions actually use; the factory must not create a
 * tracker (see the header: creation goes through
 * getSharedFileChangesTracker only, keeping event wiring exactly-once).
 */
export default function (_pi: ExtensionAPI) {
	/* no-op: this is a shared tracking module, not a real extension */
}
