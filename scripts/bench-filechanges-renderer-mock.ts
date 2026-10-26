// Jiti alias used only by bench-filechanges.ts. Baseline panel formatting is private,
// so drive its real extension factory with a tracker that publishes fixture snapshots.
export const KIND_COLORS = { created: "success", modified: "warning", deleted: "error" };
export const REPO_STATE_COLORS = {
	untracked: "muted", staged: "accent", unstaged: "muted", conflicted: "error", committed: "dim",
};
export const BENCH_TRACKER_KEY = Symbol.for("pi.filechanges.benchmark.renderer-tracker");
export function getSharedFileChangesTracker() {
	const tracker = (globalThis as any)[BENCH_TRACKER_KEY];
	if (!tracker) throw new Error("Renderer fixture tracker is not installed");
	return tracker;
}
export function __setTmpRootsForTest() {}
export default function () {}
