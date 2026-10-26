/** Session-local cumulative tracking. Originals are first-touch content, not the dirty working tree. */
import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = { timeout: 2000, killSignal: "SIGKILL" as const };
const ENTRY_SESSION_SET = "filechanges:session-set";
const BINARY_SNIFF_BYTES = 8000;
const BASH_SNIFF_MAX_CANDIDATES = 40;
const BASH_SNIFF_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_IGNORE = [
	"package-lock.json", "pnpm-lock.yaml", "yarn.lock", "*.lock", ".env", ".env.*",
	"*.tmp", "*.temp", "*~", "*.swp", "*.swo", ".#*",
	"**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**",
];

type FileSnapshot = { buf: Buffer | null; binary: boolean };
// Keep only bounded observation metadata. Originals still hold exact first-touch bytes.
type ContentSignature = { bytes: number; sha256: string } | null;
function contentSignature(buf: Buffer | null): ContentSignature {
	return buf === null ? null : { bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
}
function signaturesEqual(a: ContentSignature | undefined, b: ContentSignature): boolean {
	if (a === undefined) return false;
	return a === null || b === null ? a === b : a.bytes === b.bytes && a.sha256 === b.sha256;
}
type Kind = "created" | "modified" | "deleted";
type RepoState = "untracked" | "staged" | "unstaged" | "conflicted" | "committed";
const KINDS = new Set<string>(["created", "modified", "deleted"]);
export const KIND_COLORS: Record<Kind, ThemeColor> = { created: "success", modified: "warning", deleted: "error" };
export const REPO_STATE_COLORS: Record<RepoState, ThemeColor> = {
	untracked: "muted", staged: "accent", unstaged: "muted", conflicted: "error", committed: "dim",
};

/** Immutable projections from getChanges. Activity markers never filter the Session set. */
export interface FileChange {
	path: string;
	absPath: string;
	absolutePath: string;
	kind: Kind;
	added: number;
	removed: number;
	binary: boolean;
	updatedAt: number;
	repoState?: RepoState;
	touchedThisPrompt: boolean;
}
type TrackedChange = Omit<FileChange, "absolutePath" | "touchedThisPrompt">;
type Original = { path: string; absPath: string; snapshot: FileSnapshot };
/** Shared before-read, reserved synchronously before any tool hook yields. */
type Capture = { snapshot: Promise<FileSnapshot>; users: number };
type PendingSnapshot = { path: string; absPath: string; capture: Capture };
type PendingBash = {
	repoRoot: string | null;
	before: Map<string, string> | null;
	candidates: PendingSnapshot[];
};

export interface FileChangesTracker {
	/** Most recent content change first, with a deterministic path tie-breaker. Cached until observable state changes. */
	getChanges(): readonly FileChange[];
	getContext(): ExtensionContext | null;
	subscribe(cb: () => void): () => void;
	clear(): void;
	/** Coalesced per tracker. Notifies subscribers when Repo state changes. */
	refreshRepoStates(ctx?: ExtensionContext): Promise<boolean>;
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
	return a === null || b === null ? a === b : a.equals(b);
}
function isBinaryBuffer(buf: Buffer): boolean {
	return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}
async function readFileSnapshot(absPath: string): Promise<FileSnapshot> {
	try {
		const buf = await readFile(absPath);
		return { buf, binary: isBinaryBuffer(buf) };
	} catch {
		return { buf: null, binary: false };
	}
}
async function readCandidateSnapshot(absPath: string): Promise<FileSnapshot> {
	try {
		const st = await stat(absPath);
		if (!st.isFile() || st.size > BASH_SNIFF_MAX_BYTES) return { buf: null, binary: false };
		return await readFileSnapshot(absPath);
	} catch {
		return { buf: null, binary: false };
	}
}
function countLines(text: string): number {
	if (text === "") return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}
function normalizeToolPath(cwd: string, raw: string): { absPath: string; relPath: string } {
	const cleaned = raw.startsWith("@") ? raw.slice(1) : raw;
	const logicalPath = resolve(cwd, cleaned);
	const absPath = canonicalPath(logicalPath);
	const rel = relative(cwd, logicalPath);
	return { absPath, relPath: rel && !rel.startsWith("..") ? rel : cleaned };
}
function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
				if (glob[i + 1] === "/") i++;
			} else re += "[^/]*";
		} else if ("\\^$.|?+()[]{}".includes(c)) re += `\\${c}`;
		else re += c;
	}
	return new RegExp(`^${re}$`);
}
function readIgnoreConfig(cwd: string): string[] {
	for (const path of [join(cwd, ".pi", "settings.json"), join(homedir(), ".pi", "agent", "settings.json")]) {
		try {
			const ignore = JSON.parse(readFileSync(path, "utf8"))?.filechanges?.ignore;
			if (Array.isArray(ignore) && ignore.every((x) => typeof x === "string")) return ignore;
		} catch { /* Try the next settings file. */ }
	}
	return DEFAULT_IGNORE;
}

let tmpRoots: string[] | null = null;
let tmpRootsOverride: string[] | null = null;
function expandRoots(roots: Iterable<string>): string[] {
	const out = new Set<string>();
	for (const root of roots) {
		out.add(resolve(root));
		out.add(canonicalPath(root));
	}
	return [...out];
}
function underRoot(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}
/** Resolve aliases synchronously, retaining the missing suffix for created or deleted paths. */
function canonicalPath(path: string): string {
	let cur = resolve(path);
	const suffix: string[] = [];
	for (;;) {
		try { return join(realpathSync(cur), ...suffix.reverse()); } catch {
			const parent = dirname(cur);
			if (parent === cur) return join(cur, ...suffix.reverse());
			suffix.push(basename(cur));
			cur = parent;
		}
	}
}
function isTmpPath(absPath: string): boolean {
	const roots = tmpRootsOverride ?? (tmpRoots ??= expandRoots([resolve(tmpdir()), "/tmp", "/private/tmp", "/var/tmp"]));
	const path = resolve(absPath);
	const real = canonicalPath(path);
	return roots.some((root) => underRoot(path, root) || underRoot(real, root));
}
export function __setTmpRootsForTest(roots: string[] | null): void {
	tmpRootsOverride = roots ? expandRoots(roots) : null;
}
function sanitizeRestored(item: any): TrackedChange | null {
	if (!item || typeof item.path !== "string" || typeof item.absPath !== "string") return null;
	if (!KINDS.has(item.kind) || isTmpPath(item.absPath)) return null;
	return {
		path: item.path, absPath: canonicalPath(item.absPath), kind: item.kind,
		added: Number.isFinite(item.added) ? item.added : 0,
		removed: Number.isFinite(item.removed) ? item.removed : 0,
		binary: item.binary === true, updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
	};
}

// Conservative command sniffing, not a shell parser. Preserve the existing bounded candidate scan.
function tokenizeBash(command: string): string[] {
	const tokens: string[] = [];
	let cur = "";
	let quote: string | null = null;
	const flush = () => { if (cur) tokens.push(cur); cur = ""; };
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote !== null) {
			if (c === quote) quote = null;
			else cur += c;
		} else if (c === '"' || c === "'") quote = c;
		else if (c === "\\" && i + 1 < command.length) cur += command[++i];
		else if (/\s/.test(c) || "|;&<>()".includes(c)) flush();
		else cur += c;
	}
	flush();
	return tokens;
}
function looksLikePathToken(tok: string): boolean {
	return tok.length > 0 && tok.length <= 512 && !tok.startsWith("-") && !/[$`*?[\]{}()&|;<>=!#:]/.test(tok);
}
function expandHome(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
function extractBashCandidates(command: string, cwd: string): string[] {
	const out = new Set<string>();
	let virtualCwd = cwd;
	let expectCdTarget = false;
	for (const tok of tokenizeBash(command)) {
		if (expectCdTarget) {
			expectCdTarget = false;
			if (looksLikePathToken(tok)) virtualCwd = resolve(virtualCwd, expandHome(tok));
		} else if (tok === "cd") expectCdTarget = true;
		else if (looksLikePathToken(tok)) {
			out.add(resolve(virtualCwd, expandHome(tok)));
			if (out.size >= BASH_SNIFF_MAX_CANDIDATES) break;
		}
	}
	return [...out];
}
function repoStateFromXY(xy: string | undefined, tracked: boolean): RepoState | undefined {
	if (xy === undefined) return tracked ? "committed" : undefined;
	if (xy === "??") return "untracked";
	const [x, y] = xy;
	if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflicted";
	return x !== " " ? "staged" : "unstaged";
}
function parsePorcelainZ(stdout: string): Map<string, string> {
	const statuses = new Map<string, string>();
	const tokens = stdout.split("\0").filter(Boolean);
	for (let i = 0; i < tokens.length; i++) {
		const entry = tokens[i];
		const xy = entry.slice(0, 2);
		statuses.set(entry.slice(3), xy);
		if (/[RC]/.test(xy) && i + 1 < tokens.length) statuses.set(tokens[++i], xy);
	}
	return statuses;
}

// jiti uses independent module copies. A global registry preserves the public getter across copies.
// Ownership is per ExtensionAPI, not a global pending slot that a child session could adopt.
interface TrackerRegistry {
	bySession: Map<unknown, FileChangesTracker>;
	byOwner: WeakMap<object, FileChangesTracker>;
}
const REGISTRY_KEY = Symbol.for("pi.filechanges.tracker");
const globals = globalThis as Record<symbol, TrackerRegistry>;
const registry = (globals[REGISTRY_KEY] ??= { bySession: new Map(), byOwner: new WeakMap() });
// Legacy trackers have an incompatible contract and no ownership map. Do not retain them after reload.
if (!registry.byOwner) {
	registry.bySession.clear();
	registry.byOwner = new WeakMap();
}
delete (registry as TrackerRegistry & { pending?: unknown }).pending;
function sessionKeyOf(ctx: ExtensionContext): unknown {
	const manager = ctx.sessionManager;
	try {
		const id = manager?.getSessionId?.();
		if (id) return `session:${id}`;
	} catch { /* Mock managers can omit identity. */ }
	return manager ?? ctx;
}
export function getSharedFileChangesTracker(pi: ExtensionAPI, ctx?: ExtensionContext): FileChangesTracker {
	const existing = (ctx ? registry.bySession.get(sessionKeyOf(ctx)) : undefined) ?? registry.byOwner.get(pi);
	if (existing) return existing;
	const tracker = createTracker(pi);
	registry.byOwner.set(pi, tracker);
	return tracker;
}

function createTracker(pi: ExtensionAPI): FileChangesTracker {
	const sessionSet = new Map<string, TrackedChange>(); // absolute path identity
	const promptPaths = new Set<string>(); // display paths, persisted as activity metadata
	const originals = new Map<string, Original>();
	const observed = new Map<string, ContentSignature>();
	const captures = new Map<string, Capture>();
	const pendingByToolCallId = new Map<string, PendingSnapshot>();
	const pendingBashSnapshots = new Map<string, PendingBash>();
	const fileQueues = new Map<string, Promise<unknown>>();
	const subscribers = new Set<() => void>();
	const boundKeys = new Set<unknown>();
	let lastEventCtx: ExtensionContext | null = null;
	let alive = true;
	let generation = 0;
	let revision = 0;
	let cachedRevision = -1;
	let cachedChanges: readonly FileChange[] = Object.freeze([]);
	let dirtySinceSettle = false;
	let gitAvailable = true;
	const repoRoots = new Map<string, Promise<string | null>>();
	let realCwdCache: { cwd: string; real: string } | null = null;
	let ignoreCache: { cwd: string; matchers: RegExp[] } | null = null;
	let repoRefresh: Promise<boolean> | null = null;
	const valid = (g: number) => alive && g === generation;
	const changed = (persistent = true) => { revision++; if (persistent) dirtySinceSettle = true; };
	function notifySubscribers(): void {
		if (!alive) return;
		for (const cb of [...subscribers]) {
			try { cb(); } catch { /* Rendering cannot break tracking. */ }
		}
	}
	function bindToSession(ctx: ExtensionContext): boolean {
		if (!alive) return false;
		lastEventCtx = ctx;
		const key = sessionKeyOf(ctx);
		boundKeys.add(key);
		registry.bySession.set(key, api);
		return true;
	}
	function getRealCwd(cwd: string): string {
		if (realCwdCache?.cwd === cwd) return realCwdCache.real;
		let real = cwd;
		try { real = realpathSync(cwd); } catch { /* Keep the logical cwd. */ }
		realCwdCache = { cwd, real };
		return real;
	}
	function isIgnored(path: string, cwd: string): boolean {
		if (ignoreCache?.cwd !== cwd) {
			ignoreCache = { cwd, matchers: readIgnoreConfig(cwd).map(globToRegExp) };
		}
		const normalized = path.split(sep).join("/");
		const base = basename(normalized);
		return ignoreCache.matchers.some((re) => re.test(normalized) || re.test(base));
	}
	function getChanges(): readonly FileChange[] {
		if (cachedRevision !== revision) {
			cachedChanges = Object.freeze([...sessionSet.values()]
				.sort((a, b) => b.updatedAt - a.updatedAt || (a.absPath < b.absPath ? -1 : a.absPath > b.absPath ? 1 : 0))
				.map((item) => Object.freeze({ ...item, absolutePath: item.absPath, touchedThisPrompt: promptPaths.has(item.path) })));
			cachedRevision = revision;
		}
		return cachedChanges;
	}
	function persistSessionSet(): void {
		if (!alive) return;
		const items = [...sessionSet.values()].map(({ repoState: _state, ...rest }) => rest);
		pi.appendEntry(ENTRY_SESSION_SET, { items, promptPaths: [...promptPaths] });
	}
	function reserveCapture(absPath: string, candidate: boolean): Capture {
		let capture = captures.get(absPath);
		if (!capture) {
			capture = { snapshot: candidate ? readCandidateSnapshot(absPath) : readFileSnapshot(absPath), users: 0 };
			captures.set(absPath, capture);
		}
		capture.users++;
		return capture;
	}
	function releaseCapture(pending: PendingSnapshot): void {
		pending.capture.users--;
		if (pending.capture.users === 0 && captures.get(pending.absPath) === pending.capture) captures.delete(pending.absPath);
	}
	function queueFile<T>(absPath: string, g: number, fn: () => Promise<T>): Promise<T | undefined> {
		const previous = fileQueues.get(absPath) ?? Promise.resolve();
		const task = previous.catch(() => {}).then(() => valid(g) ? fn() : undefined);
		fileQueues.set(absPath, task);
		void task.finally(() => { if (fileQueues.get(absPath) === task) fileQueues.delete(absPath); }).catch(() => {});
		return task;
	}
	function markPrompt(path: string): void {
		if (!promptPaths.has(path)) { promptPaths.add(path); changed(); }
	}
	function replaceChange(next: TrackedChange): void {
		const previous = sessionSet.get(next.absPath);
		if (previous && Object.keys(next).every((key) => next[key as keyof TrackedChange] === previous[key as keyof TrackedChange])) return;
		sessionSet.set(next.absPath, next);
		changed();
	}

	async function computeDiffStats(cwd: string, before: string | null, after: string | null): Promise<{ added: number; removed: number }> {
		if (before === after) return { added: 0, removed: 0 };
		if (!gitAvailable) {
			if (before === null) return { added: countLines(after ?? ""), removed: 0 };
			if (after === null) return { added: 0, removed: countLines(before ?? "") };
			return { added: 0, removed: 0 };
		}
		const dir = await mkdtemp(join(tmpdir(), "pi-filechanges-"));
		try {
			const beforePath = join(dir, "a");
			const afterPath = join(dir, "b");
			await Promise.all([writeFile(beforePath, before ?? "", "utf8"), writeFile(afterPath, after ?? "", "utf8")]);
			let stdout = "";
			try {
				stdout = (await execFileAsync("git", ["diff", "--no-index", "--numstat", beforePath, afterPath], { ...EXEC_OPTIONS, cwd })).stdout;
			} catch (error: any) {
				if (error?.code === "ENOENT") { gitAvailable = false; return computeDiffStats(cwd, before, after); }
				// Only exit 1 is a successful no-index diff. Timeouts and other failures have no usable stats.
				if (error?.code === 1 && !error?.killed) stdout = error.stdout ?? "";
			}
			const [added, removed] = stdout.trim().split(/\s+/).map(Number);
			return { added: Number.isFinite(added) ? added : 0, removed: Number.isFinite(removed) ? removed : 0 };
		} finally { await rm(dir, { recursive: true, force: true }); }
	}
	/** Called inside the per-file queue. Last observed signatures avoid repeated diffs and timestamp churn. */
	async function refreshChange(ctx: ExtensionContext, absPath: string, g: number, current?: FileSnapshot): Promise<void> {
		const original = originals.get(absPath);
		if (!original || !valid(g)) return;
		current ??= await readFileSnapshot(absPath);
		if (!valid(g) || originals.get(absPath) !== original) return;
		if (buffersEqual(original.snapshot.buf, current.buf)) {
			const hadRow = sessionSet.delete(absPath);
			const hadMarker = promptPaths.delete(original.path);
			originals.delete(absPath);
			observed.delete(absPath);
			if (hadRow || hadMarker) changed();
			return;
		}
		const signature = contentSignature(current.buf);
		if (signaturesEqual(observed.get(absPath), signature)) return;
		const binary = original.snapshot.binary || current.binary;
		const stats = binary ? { added: 0, removed: 0 } : await computeDiffStats(ctx.cwd,
			original.snapshot.buf?.toString("utf8") ?? null, current.buf?.toString("utf8") ?? null);
		if (!valid(g) || originals.get(absPath) !== original) return;
		observed.set(absPath, signature);
		replaceChange({
			path: original.path, absPath, kind: original.snapshot.buf === null ? "created" : current.buf === null ? "deleted" : "modified",
			...stats, binary, updatedAt: Date.now(), repoState: sessionSet.get(absPath)?.repoState,
		});
	}
	async function trackCaptured(ctx: ExtensionContext, pending: PendingSnapshot, g: number, candidate: boolean): Promise<void> {
		const before = await pending.capture.snapshot;
		await queueFile(pending.absPath, g, async () => {
			const current = candidate ? await readCandidateSnapshot(pending.absPath) : await readFileSnapshot(pending.absPath);
			if (!valid(g) || buffersEqual(before.buf, current.buf)) return;
			if (!originals.has(pending.absPath)) originals.set(pending.absPath, { path: pending.path, absPath: pending.absPath, snapshot: before });
			await refreshChange(ctx, pending.absPath, g, current);
			if (valid(g) && sessionSet.has(pending.absPath)) markPrompt(sessionSet.get(pending.absPath)!.path);
		});
	}

	async function getRepoRoot(cwd: string): Promise<string | null> {
		if (!gitAvailable) return null;
		const cached = repoRoots.get(cwd);
		if (cached) return cached;
		const lookup = execFileAsync("git", ["rev-parse", "--show-toplevel"], { ...EXEC_OPTIONS, cwd })
			.then((res) => res.stdout.trim() || null, (error) => { if (error?.code === "ENOENT") gitAvailable = false; return null; });
		repoRoots.set(cwd, lookup);
		return lookup;
	}
	async function snapshotGitStatus(root: string): Promise<Map<string, string> | null> {
		try {
			return parsePorcelainZ((await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
				{ ...EXEC_OPTIONS, cwd: root, maxBuffer: 10 * 1024 * 1024 })).stdout);
		} catch (error: any) { if (error?.code === "ENOENT") gitAvailable = false; return null; }
	}
	async function listTrackedFiles(root: string): Promise<Set<string> | null> {
		try {
			return new Set((await execFileAsync("git", ["ls-files", "-z"],
				{ ...EXEC_OPTIONS, cwd: root, maxBuffer: 10 * 1024 * 1024 })).stdout.split("\0").filter(Boolean));
		} catch (error: any) { if (error?.code === "ENOENT") gitAvailable = false; return null; }
	}
	async function readGitHeadSnapshot(root: string, path: string): Promise<FileSnapshot> {
		try {
			const res = await execFileAsync("git", ["show", `HEAD:${path}`],
				{ ...EXEC_OPTIONS, cwd: root, encoding: "buffer", maxBuffer: 20 * 1024 * 1024 });
			const buf = res.stdout;
			return { buf, binary: isBinaryBuffer(buf) };
		} catch (error: any) { if (error?.code === "ENOENT") gitAvailable = false; return { buf: null, binary: false }; }
	}
	function resolveExistingPath(path: string): string {
		return canonicalPath(path);
	}
	function isInside(root: string, path: string): boolean {
		const rel = relative(root, path);
		return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	}
	async function doRefreshRepoStates(ctx: ExtensionContext, g: number, known?: { root: string; statuses: Map<string, string> | null }): Promise<boolean> {
		if (!valid(g) || !sessionSet.size) return false;
		const cwdRoot = await getRepoRoot(ctx.cwd);
		const byRepo = new Map<string, { item: TrackedChange; rel: string }[]>();
		const updates: { item: TrackedChange; state: RepoState | undefined }[] = [];
		for (const item of [...sessionSet.values()]) {
			if (!valid(g)) return false;
			const realAbs = await resolveExistingPath(item.absPath);
			const root = cwdRoot && isInside(cwdRoot, realAbs) ? cwdRoot : await getRepoRoot(dirname(realAbs));
			if (!root) { updates.push({ item, state: undefined }); continue; }
			const entries = byRepo.get(root) ?? [];
			entries.push({ item, rel: relative(root, realAbs).split(sep).join("/") });
			byRepo.set(root, entries);
		}
		for (const [root, entries] of byRepo) {
			if (!valid(g)) return false;
			const [statuses, tracked] = await Promise.all([
				known?.root === root ? known.statuses : snapshotGitStatus(root), listTrackedFiles(root),
			]);
			for (const { item, rel } of entries) {
				// A failed status is unknown, never porcelain silence. Failed ls-files cannot prove committed either.
				updates.push({ item, state: statuses ? repoStateFromXY(statuses.get(rel), tracked?.has(rel) ?? false) : undefined });
			}
		}
		if (!valid(g)) return false;
		let didChange = false;
		for (const { item, state } of updates) {
			if (sessionSet.get(item.absPath) !== item || item.repoState === state) continue;
			sessionSet.set(item.absPath, { ...item, repoState: state });
			changed(false);
			didChange = true;
		}
		return didChange;
	}
	function refreshRepoStates(ctx = lastEventCtx ?? undefined, known?: { root: string; statuses: Map<string, string> | null }): Promise<boolean> {
		if (!ctx || !alive) return Promise.resolve(false);
		if (repoRefresh) return repoRefresh;
		const task = doRefreshRepoStates(ctx, generation, known).then((result) => { if (result) notifySubscribers(); return result; });
		repoRefresh = task;
		void task.finally(() => { if (repoRefresh === task) repoRefresh = null; }).catch(() => {});
		return task;
	}

	function resetState(): void {
		generation++;
		sessionSet.clear(); promptPaths.clear(); originals.clear(); observed.clear(); captures.clear();
		pendingByToolCallId.clear(); pendingBashSnapshots.clear(); fileQueues.clear(); repoRoots.clear();
		repoRefresh = null; realCwdCache = null; ignoreCache = null; dirtySinceSettle = false;
		changed(false);
		// Release cached projections as well as content buffers.
		cachedChanges = Object.freeze([]); cachedRevision = revision;
	}
	async function restoreSessionSet(ctx: ExtensionContext): Promise<void> {
		resetState();
		const g = generation;
		let data: any = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ENTRY_SESSION_SET) data = entry.data;
		}
		for (const item of Array.isArray(data?.items) ? data.items : []) {
			const change = sanitizeRestored(item);
			if (change) sessionSet.set(change.absPath, change);
		}
		// Legacy Round is activity metadata only. Saved Mode never changes visibility.
		const paths = Array.isArray(data?.promptPaths) ? data.promptPaths : Array.isArray(data?.round) ? data.round : [...sessionSet.values()].map((item) => item.path);
		for (const path of paths) if (typeof path === "string") promptPaths.add(path);
		changed(false);
		const root = sessionSet.size ? await getRepoRoot(ctx.cwd) : null;
		for (const change of [...sessionSet.values()]) {
			if (!valid(g)) return;
			if (!root || !isInside(root, change.absPath)) continue;
			// Preserve the existing reload baseline: HEAD for saved paths in the cwd repo, frozen counts elsewhere.
			const snapshot = await readGitHeadSnapshot(root, relative(root, change.absPath).split(sep).join("/"));
			const current = await readFileSnapshot(change.absPath);
			if (!valid(g)) return;
			originals.set(change.absPath, { path: change.path, absPath: change.absPath, snapshot });
			observed.set(change.absPath, contentSignature(current.buf));
		}
		if (!valid(g)) return;
		await refreshRepoStates(ctx);
		if (valid(g)) { dirtySinceSettle = false; notifySubscribers(); }
	}

	pi.on("tool_call", async (event, ctx) => {
		if (!bindToSession(ctx)) return;
		const g = generation;
		if (event.toolName === "edit" || event.toolName === "write") {
			const raw = event.input.path;
			if (typeof raw !== "string") return;
			const { absPath, relPath } = normalizeToolPath(ctx.cwd, raw);
			if (isTmpPath(absPath) || isIgnored(relPath, ctx.cwd)) return;
			const pending = { path: relPath, absPath, capture: reserveCapture(absPath, false) };
			pendingByToolCallId.set(event.toolCallId, pending);
			await pending.capture.snapshot;
			return;
		}
		if (event.toolName !== "bash") return;
		const command = typeof event.input.command === "string" ? event.input.command : "";
		const cwd = getRealCwd(ctx.cwd);
		// Reserve all before-reads before awaiting Git. Parallel hooks reuse the earliest read for a file.
		const candidatesByPath = new Map<string, PendingSnapshot>();
		for (const raw of extractBashCandidates(command, cwd)) {
			const { absPath, relPath } = normalizeToolPath(cwd, raw);
			if (candidatesByPath.has(absPath) || isTmpPath(absPath) || isIgnored(relPath, ctx.cwd)) continue;
			candidatesByPath.set(absPath, { absPath, path: relPath, capture: reserveCapture(absPath, true) });
		}
		const candidates = [...candidatesByPath.values()];
		const pending: PendingBash = { repoRoot: null, before: null, candidates };
		pendingBashSnapshots.set(event.toolCallId, pending);
		const root = await getRepoRoot(ctx.cwd);
		if (!valid(g)) return;
		pending.repoRoot = root;
		const [before] = await Promise.all([root ? snapshotGitStatus(root) : null, ...candidates.map((item) => item.capture.snapshot)]);
		if (valid(g)) pending.before = before;
	});

	// Claim pending snapshots before yielding. A normal result and the execution-end backstop cannot release them twice.
	function takePending(toolCallId: string) {
		const pending = pendingByToolCallId.get(toolCallId);
		const bash = pendingBashSnapshots.get(toolCallId);
		pendingByToolCallId.delete(toolCallId);
		pendingBashSnapshots.delete(toolCallId);
		return { pending, bash };
	}
	function releasePending(pending: PendingSnapshot | undefined, bash: PendingBash | undefined): void {
		if (pending) releaseCapture(pending);
		for (const candidate of bash?.candidates ?? []) releaseCapture(candidate);
	}
	async function reconcileToolCall(toolCallId: string, ctx: ExtensionContext, includeRepoStatus: boolean): Promise<void> {
		const g = generation;
		const startRevision = revision;
		// Results marked as errors can still have changed files. Reconcile captured paths on either outcome.
		const { pending, bash } = takePending(toolCallId);
		try {
			if (pending) await trackCaptured(ctx, pending, g, false);
			if (!bash) return;
			for (const candidate of bash.candidates) {
				if (!valid(g)) return;
				await trackCaptured(ctx, candidate, g, true);
			}
			if (!includeRepoStatus || !bash.repoRoot || !valid(g)) return;
			const after = await snapshotGitStatus(bash.repoRoot);
			if (!valid(g)) return;
			// Only status membership transitions are fallback candidates. Do not scan the whole dirty repo.
			if (bash.before && after) {
				const touched = new Set([...bash.before.keys(), ...after.keys()].filter((path) => bash.before!.has(path) !== after.has(path)));
				const cwd = getRealCwd(ctx.cwd);
				for (const repoRel of touched) {
					if (!valid(g)) return;
					const absPath = canonicalPath(resolve(bash.repoRoot, repoRel));
					const { relPath } = normalizeToolPath(cwd, absPath);
					if (isTmpPath(absPath) || isIgnored(relPath, ctx.cwd)) continue;
					await queueFile(absPath, g, async () => {
						if (!originals.has(absPath)) {
							const snapshot = await readGitHeadSnapshot(bash.repoRoot!, repoRel);
							if (!valid(g)) return;
							originals.set(absPath, { path: relPath, absPath, snapshot });
						}
						await refreshChange(ctx, absPath, g);
						if (valid(g) && sessionSet.has(absPath)) markPrompt(sessionSet.get(absPath)!.path);
					});
				}
			}
			await refreshRepoStates(ctx, { root: bash.repoRoot, statuses: after });
		} finally {
			releasePending(pending, bash);
			if (valid(g) && revision !== startRevision) notifySubscribers();
		}
	}
	pi.on("tool_result", async (event, ctx) => {
		if (bindToSession(ctx)) await reconcileToolCall(event.toolCallId, ctx, true);
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		if (!bindToSession(ctx)) return;
		if (!pendingByToolCallId.has(event.toolCallId) && !pendingBashSnapshots.has(event.toolCallId)) return;
		// Pi omits durationMs when preparation blocked or aborted before execute(). No mutation can be attributed to that call.
		if (event.durationMs === undefined) {
			const { pending, bash } = takePending(event.toolCallId);
			releasePending(pending, bash);
			return;
		}
		// Execution did run but the result hook was missed. Reconcile captured paths, never unrelated status transitions.
		await reconcileToolCall(event.toolCallId, ctx, false);
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (!bindToSession(ctx) || !dirtySinceSettle) return;
		const g = generation;
		const startRevision = revision;
		for (const absPath of [...originals.keys()]) {
			if (!valid(g)) return;
			await queueFile(absPath, g, () => refreshChange(ctx, absPath, g));
		}
		await refreshRepoStates(ctx);
		if (!valid(g)) return;
		dirtySinceSettle = false;
		persistSessionSet();
		if (revision !== startRevision) notifySubscribers();
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (!bindToSession(ctx) || (event.messageType !== undefined && event.messageType !== "user")) return;
		if (!promptPaths.size) return;
		promptPaths.clear();
		// Activity metadata changes the projection, not file content. Preserve any earlier content dirty flag.
		changed(false);
		// Persist immediately, even if this prompt fails or never produces a tool call. No Git work here.
		persistSessionSet();
		notifySubscribers();
	});
	pi.on("session_start", async (_event, ctx) => { if (bindToSession(ctx)) await restoreSessionSet(ctx); });
	pi.on("session_tree", async (_event, ctx) => { if (bindToSession(ctx)) await restoreSessionSet(ctx); });
	pi.on("session_shutdown", () => {
		if (!alive) return;
		resetState();
		alive = false;
		subscribers.clear();
		lastEventCtx = null;
		for (const key of boundKeys) if (registry.bySession.get(key) === api) registry.bySession.delete(key);
		boundKeys.clear();
		if (registry.byOwner.get(pi) === api) registry.byOwner.delete(pi);
	});

	const api: FileChangesTracker = {
		getChanges,
		getContext: () => lastEventCtx,
		subscribe(cb) { if (alive) subscribers.add(cb); return () => { subscribers.delete(cb); }; },
		clear() {
			if (!alive) return;
			resetState();
			persistSessionSet();
			notifySubscribers();
		},
		refreshRepoStates: (ctx) => refreshRepoStates(ctx),
	};
	return api;
}

/** Pi discovers this utility as an extension. Only the named getter wires tracking hooks. */
export default function (_pi: ExtensionAPI): void {}
