/**
 * split-status.ts — mirror transient chat status lines into the response doc.
 *
 * pi renders extension `ui.notify` output (info → showStatus, warning →
 * showWarning, error → showError) and its own transient statuses
 * ("Forked to new session", "Auto-compaction cancelled", ...) as ThemedText
 * lines appended to the transcript's chat container. They are UI-only:
 * never session entries, so response-only mode's branch-built doc could not
 * show them. The whole class was invisible while the split owned the screen:
 * extension notify output appeared nowhere (pi-blackhole's
 * /blackhole-memory status, worker notices), and neither did split's own
 * command feedback ("Right column on", "Split off"), which is what the
 * notify assertions in the E2E suite were failing on.
 *
 * This module watches the detached transcript subtree once per TUI frame
 * and mirrors each new status line to the doc bottom. It mirrors the
 * COMPONENT INSTANCE, not extracted text: ThemedText rebuilds through its
 * live theme closure, so pi's back-to-back status replacement (showStatus
 * reuses the last ThemedText instead of appending when statuses arrive one
 * after another) propagates to the mirrored doc row automatically, and
 * multi-line notify bodies wrap at the doc's own width.
 *
 * Native parity, transient class: a doc rebuild (tree switch) drops rows
 * emitted before it, like pi's transcript loses statuses to scrollback.
 * Statuses emitted while the FULL transcript owns the left column are not
 * mirrored — they were already visible there once; the doc keeps the
 * conversation, not a log.
 *
 * Cost: the watch set is fixed at attach time (the transcript's structural
 * containers, a handful); the per-frame poll is a length compare per
 * container. Message content that arrives later (markdown blocks and their
 * internals) is deliberately NOT added to the watch set — those are
 * messages, not statuses, and watching them would make the per-frame cost
 * grow with transcript length.
 */
import { Spacer } from "@earendil-works/pi-tui";
import { getResponseDoc } from "./split-response.ts";
import { findTranscriptScrollView } from "./split-sticky.ts";

/** Containers watched for new status lines, each with its consumed cursor. */
let watched = new WeakMap<object, number>();
/** Attachment snapshot of the same objects, for identity-stable iteration. */
let watchedList: object[] = [];
/** True only while response-only mode owns the left column. */
let active: () => boolean = () => false;
/** Base root getter (lazy attach keeps this module out of composeLayout). */
let getBase: () => any = () => null;

export function initStatusMirror(baseGetter: () => any, activeFn: () => boolean): void {
	getBase = baseGetter;
	active = activeFn;
}

export function resetStatusMirror(): void {
	watched = new WeakMap();
	watchedList = [];
}

// A status line in pi's chat container is a ThemedText: a text component
// with a build() closure (pi's wrapper class is internal to the mode, so the
// two public-API traits identify it). NO instanceof: pi bundles its own copy
// of pi-tui, so a class from the node_modules copy never matches a component
// pi created from the bundled one.
const isStatusLine = (child: any): boolean =>
	typeof child?.build === "function" && typeof child?.render === "function";

// Set SPLIT_STATUS_DEBUG=1 to trace the mirror chain (attach, per-poll child
// shapes, mirrors) to /tmp/split-status-debug.log — for TUI debugging, where
// there is no console to read.
const debugLog = (msg: string): void => {
	if (process.env.SPLIT_STATUS_DEBUG !== "1") return;
	try {
		const fs = require("node:fs") as { appendFileSync(p: string, s: string): void };
		fs.appendFileSync("/tmp/split-status-debug.log", `${Date.now()} ${msg}\n`);
	} catch {
		/* diagnostics must never break the render loop */
	}
};

/** Collect every descendant (and the node itself) exposing a children array. */
const collectContainers = (node: any, out: object[] = [], depth = 0): object[] => {
	if (!node || depth > 6 || out.length > 32) return out;
	if (Array.isArray(node?.children)) out.push(node);
	for (const c of node?.children ?? []) collectContainers(c, out, depth + 1);
	// Stack-style containers may hold entries instead (pi layout wrappers).
	for (const e of node?.entries ?? []) {
		if (e?.component) collectContainers(e.component, out, depth + 1);
	}
	return out;
};

/** Find new status lines across the watched containers. */
const pollWatched = (): boolean => {
	let appended = false;
	const doc = getResponseDoc();
	for (const container of watchedList) {
		const children: any[] = (container as any).children;
		if (!Array.isArray(children)) continue;
		let cursor = watched.get(container) ?? children.length;
		while (cursor < children.length) {
			const child = children[cursor];
			cursor++;
			debugLog(`child: ${child?.constructor?.name} status=${isStatusLine(child)}`);
			if (isStatusLine(child)) {
				// Blank row above, exactly like showStatus lays it out.
				doc.addChild(new Spacer(1));
				doc.addChild(child);
				appended = true;
				debugLog("mirrored one status line");
			}
		}
		watched.set(container, cursor);
	}
	return appended;
};

/**
 * Per-frame poll. Returns true when a status row was mirrored (the caller
 * re-renders). First poll attaches at the CURRENT tail: history already
 * rendered once in the full transcript; only statuses emitted from now on
 * are mirrored.
 */
export function pollStatusLines(): boolean {
	if (!active()) return false;
	const scroll = findTranscriptScrollView(getBase());
	const root = scroll?.child;
	if (!root || !Array.isArray(root.children)) return false;
	if (watchedList.length === 0 || !watched.has(root)) {
		watched = new WeakMap();
		watchedList = collectContainers(root);
		for (const c of watchedList) watched.set(c, (c as any).children.length);
		debugLog(`attach: ${watchedList.length} containers, root children=${root.children.length}`);
		return false;
	}
	if (pollWatched()) {
		getResponseDoc().invalidate();
		return true;
	}
	return false;
}
