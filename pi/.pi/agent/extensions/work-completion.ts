import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface RepoStatus {
	root: string;
	commonDir: string;
	branch: string | null;
	head: string;
	dirty: { path: string; status: string }[];
	upstream: string | null;
	ahead: number | null;
	behind: number | null;
	defaultBranch: string | null;
	isHelloFresh: boolean;
	publication: "cached" | "unknown";
	operation: boolean;
}
interface SavedState {
	version: 1;
	sessionId: string;
	root: string;
	baseline: Pick<RepoStatus, "head" | "dirty">;
	lastStatus: RepoStatus;
	changedObserved: boolean;
}
const entryType = "work-completion:state";
const key = "work-completion";
const interactive = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.hasUI;
const nullableString = (v: unknown) => v === null || typeof v === "string";
const nullableCount = (v: unknown) => v === null || (Number.isSafeInteger(v) && Number(v) >= 0);
function validDirty(v: any): v is RepoStatus["dirty"] {
	return Array.isArray(v) && v.every((d) => d && typeof d.path === "string" && typeof d.status === "string");
}
export function parseRepoStatus(value: any): RepoStatus {
	if (!value || typeof value.root !== "string" || !isAbsolute(value.root) ||
		typeof value.commonDir !== "string" || typeof value.head !== "string" || !validDirty(value.dirty) ||
		!nullableString(value.branch) || !nullableString(value.upstream) || !nullableString(value.defaultBranch) ||
		!nullableCount(value.ahead) || !nullableCount(value.behind) || typeof value.isHelloFresh !== "boolean" ||
		typeof value.operation !== "boolean" || !["cached", "unknown"].includes(value.publication)) {
		throw new Error("Invalid repo-guard status");
	}
	// Copy only the metadata contract. Do not retain unexpected CLI fields or file content.
	return { root: value.root, commonDir: value.commonDir, branch: value.branch, head: value.head,
		dirty: value.dirty.map((d: any) => ({ path: d.path, status: d.status })).sort((a: any, b: any) =>
			a.path.localeCompare(b.path) || a.status.localeCompare(b.status)), upstream: value.upstream,
		ahead: value.ahead, behind: value.behind, defaultBranch: value.defaultBranch,
		isHelloFresh: value.isHelloFresh, publication: value.publication, operation: value.operation };
}
export function scanRepoStatus(cwd: string, signal: AbortSignal): Promise<RepoStatus> {
	const script = process.env.PI_REPO_GUARD_BIN ?? join(homedir(), ".local/bin/repo-guard");
	if (!isAbsolute(script)) return Promise.reject(new Error("repo-guard path must be absolute"));
	return new Promise((resolve, reject) => {
		execFile(process.execPath, [script, "status", "--json", "--cwd", cwd], {
			signal, timeout: 5000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8",
		}, (error, stdout) => {
			if (error) { reject(error); return; }
			try { resolve(parseRepoStatus(JSON.parse(stdout))); } catch (error) { reject(error); }
		});
	});
}
const workSignature = (s: Pick<RepoStatus, "head" | "dirty">) => JSON.stringify([
	s.head, s.dirty.map((d) => [d.path, d.status]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
]);
const statusSignature = (s: RepoStatus) => JSON.stringify([workSignature(s), s.root, s.commonDir, s.branch,
	s.upstream, s.ahead, s.behind, s.defaultBranch, s.publication, s.operation, s.isHelloFresh]);
const plain = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
function summary(state: SavedState): string {
	const s = state.lastStatus;
	const present = s.dirty.filter((d) => state.baseline.dirty.some((b) => b.path === d.path)).length;
	if (s.operation) return `Work pending: Git operation in progress. ${s.dirty.length} changed. /work-status`;
	if (s.dirty.length) return `Work pending: ${s.dirty.length} changed (${present} present at start). Review/commit needed. /work-status`;
	if (s.ahead !== null && s.ahead > 0) return `Work pending: ${s.ahead} local commit(s) ahead of cached upstream. /work-status`;
	if (s.behind !== null && s.behind > 0) return `Worktree clean; ${s.behind} commit(s) behind cached upstream. /work-status`;
	if (s.publication === "cached" && s.ahead === 0 && s.behind === 0) return "Worktree clean; matches cached upstream. /work-status";
	return "Worktree clean; publication unknown. /work-status";
}
const pendingWork = (state: SavedState) => state.lastStatus.operation || state.lastStatus.dirty.length > 0 ||
	(state.lastStatus.ahead !== null && state.lastStatus.ahead > 0);
const removalReminder = (s: RepoStatus) => s.branch && s.branch !== s.defaultBranch && !["main", "master", "live"].includes(s.branch) ?
	"\nBefore removing this checkout, run repo-guard check-remove for fresh proof and inspect ignored files." : "";
function restore(ctx: ExtensionContext, root: string, sessionId: string): SavedState | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== entryType) continue;
		const data = entry.data as SavedState | undefined;
		if (!data || data.version !== 1 || data.root !== root || data.sessionId !== sessionId ||
			typeof data.changedObserved !== "boolean" || typeof data.baseline?.head !== "string" || !validDirty(data.baseline.dirty)) continue;
		try {
			const lastStatus = parseRepoStatus(data.lastStatus);
			if (lastStatus.root !== root) continue;
			return { version: 1, sessionId, root, changedObserved: data.changedObserved,
				baseline: { head: data.baseline.head, dirty: data.baseline.dirty.map((d) => ({ path: d.path, status: d.status })) }, lastStatus };
		} catch { /* Ignore malformed entries, never put them in model context. */ }
	}
}

/** The optional scanner is for isolated tests. Each runtime owns its generation and scan queue. */
export default function workCompletion(pi: ExtensionAPI, scan = scanRepoStatus) {
	let generation = 0;
	let owner: { sessionId: string; cwd: string; generation: number; controller: AbortController } | undefined;
	let state: SavedState | undefined;
	let saved = "";
	let failedWarning = false;
	let queue: Promise<void> = Promise.resolve();
	const owns = (ctx: ExtensionContext, token = owner) => interactive(ctx) && !!token && token === owner &&
		token.generation === generation && token.sessionId === ctx.sessionManager.getSessionId() && token.cwd === ctx.cwd;
	function paint(ctx: ExtensionContext, text: string) {
		if (!owns(ctx)) return;
		const color = text.startsWith("Work status unavailable") || (state && pendingWork(state)) ? "warning" : "dim";
		ctx.ui.setWidget(key, (_tui, theme) => ({ render: (width) => [truncateToWidth(theme.fg(color, text), width)], invalidate() {} }));
		if (!owns(ctx)) return;
		ctx.ui.setStatus(key, state && !text.startsWith("Work status unavailable") ?
			`Work: ${state.lastStatus.dirty.length} changed; /work-status` : "Work status unavailable; /work-status");
	}
	function persist(ctx: ExtensionContext) {
		if (!owns(ctx) || !state) return;
		const serialized = JSON.stringify(state);
		if (serialized === saved) return;
		pi.appendEntry(entryType, JSON.parse(serialized));
		saved = serialized;
	}
	function refresh(ctx: ExtensionContext, reason: "start" | "settled" | "command") {
		if (!owns(ctx)) return Promise.resolve();
		const token = owner!;
		const pending = queue.then(async () => {
			if (!owns(ctx, token)) return;
			try {
				const current = parseRepoStatus(await scan(ctx.cwd, token.controller.signal));
				if (!owns(ctx, token) || token.controller.signal.aborted) return;
				if (!state || state.root !== current.root) {
					state = restore(ctx, current.root, token.sessionId);
					saved = state ? JSON.stringify(state) : "";
				}
				const previous = state?.lastStatus;
				if (!state) state = { version: 1, sessionId: token.sessionId, root: current.root,
					baseline: { head: current.head, dirty: current.dirty.map((d) => ({ ...d })) }, lastStatus: current, changedObserved: false };
				if (workSignature(current) !== workSignature(state.baseline) ||
					(previous && workSignature(previous) !== workSignature(current))) state.changedObserved = true;
				state.lastStatus = current;
				persist(ctx);
				paint(ctx, summary(state));
				if (!owns(ctx, token)) return;
				if (reason === "command") {
					ctx.ui.notify(`${plain(current.root)} (${plain(current.branch ?? "detached HEAD")})\n` +
						`Dirty: ${state.baseline.dirty.length} at start, ${current.dirty.length} now. Session change observed: ${state.changedObserved ? "yes" : "no"} (not attribution).\n` +
						`Publication: ${current.publication}. Ahead: ${current.ahead ?? "unknown"}, behind: ${current.behind ?? "unknown"}. Fresh publication and deployment not checked.\n` +
						summary(state) + removalReminder(current), "info");
				} else if (reason === "settled" && previous && statusSignature(previous) !== statusSignature(current)) {
					ctx.ui.notify(summary(state), pendingWork(state) ? "warning" : "info");
				}
			} catch {
				if (!owns(ctx, token) || token.controller.signal.aborted) return;
				paint(ctx, "Work status unavailable: repo-guard scan failed. /work-status");
				if (!failedWarning && owns(ctx, token)) {
					failedWarning = true;
					ctx.ui.notify("Work status unavailable: repo-guard scan failed. No completion or publication check was made.", "warning");
				}
			}
		});
		queue = pending.catch(() => {});
		return pending;
	}
	function start(ctx: ExtensionContext) {
		if (!interactive(ctx)) return Promise.resolve();
		owner?.controller.abort();
		generation++;
		owner = { sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, generation, controller: new AbortController() };
		state = undefined;
		saved = "";
		failedWarning = false;
		// Old queued tasks cannot own the new runtime. The aborted child exits before its queue drains.
		return refresh(ctx, "start");
	}
	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("session_tree", (_event, ctx) => start(ctx));
	pi.on("agent_settled", (_event, ctx) => refresh(ctx, "settled"));
	pi.on("session_shutdown", (_event, ctx) => {
		if (!owns(ctx)) return;
		owner!.controller.abort();
		if (owns(ctx)) ctx.ui.setWidget(key, undefined);
		if (owns(ctx)) ctx.ui.setStatus(key, undefined);
		generation++;
		owner = undefined;
		state = undefined;
	});
	pi.registerCommand("work-status", {
		description: "Show local checkout state and cached upstream metadata",
		handler: (_args, ctx) => refresh(ctx, "command"),
	});
}
