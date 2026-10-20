/**
 * split-response.ts — response-only view ("Panel C"), ported from the retired
 * upstream split-view.ts trim mode.
 *
 * Owns the response document: user + assistant messages only, rendered with
 * pi's own transcript components. Built from the branch (session start / tree
 * switch) and streamed live (message_start/update/end). Assistant content is
 * filtered to drop thinking blocks (the thinking panel owns those) — tool
 * calls never render here (the tool panel owns those), so an assistant
 * message with no text is skipped. Error/abort markers are retained.
 *
 * No-information-loss policy (user decision 2026-10-24): everything pi's own
 * transcript renders must be visible SOMEWHERE while the split owns the
 * screen, but the response column stays noise-free. So the doc keeps only
 * conversational content, and the rest is dispatched to the Tool Usage panel
 * as event rows (split-panels.ts):
 *   - `!`/`!!` bash blocks      → doc (BashExecutionComponent, native parity)
 *   - skill-invocation turns    → doc shows the real user prompt (if any),
 *                                 panel gets a "skill: <name>" row; the raw
 *                                 <skill …> block never leaks into the doc
 *   - compaction                 → clears the doc (native parity) + panel row
 *   - branch summaries           → panel row
 *   - custom display messages    → panel row
 *   - tool calls/results         → tool panel rows (existing owner)
 *   - `custom` extension entries → skipped: extension-internal data whose
 *     owning view already presents it (e.g. the filechanges tracker feeds the
 *     File Changes panel); no display renderer is reachable from here.
 *
 * The doc lives under ONE retained ScrollView singleton. The instance is
 * created once and NEVER recreated across toggles or branch switches, so the
 * NUMERIC scroll offset is preserved (and clamped into new content) across
 * rebuilds — exactly like the native transcript on the same /tree switch.
 *
 * Live gaps pi leaves open (no extension events exist) are closed by
 * syncBranchEntries(): a leaf-id diff walked once per TUI frame from the
 * widget render loop (O(1) when nothing changed). bash_execution_update and
 * entry_appended never reach the extension runner, so the walk is the only
 * public-API way to learn that a bang command result, compaction, branch
 * summary, or custom message landed in the branch. user_bash only tells us a
 * command STARTED (its handler must never throw — pi aborts the command then).
 *
 * Response-only is native-parity BY DESIGN (SV-09/SV-10/SV-18, USER DECISION
 * 2026-10-07, decisions/E-policy.md): it shows TEXT content only — pi's own
 * transcript renders user messages as text and drops non-text blocks, so
 * image-only user turns render nothing there either; it keeps FULL scrollback
 * (unbounded — pi's own transcript is unbounded and offers no virtualization
 * primitive, so this matches the platform's cost model, a constant factor
 * only); and it preserves the numeric scroll offset across branch switches.
 * Toggling the response view itself does not move the doc's scroll position.
 *
 * This module is a shared utility imported by split.ts. pi auto-discovers
 * every *.ts file in this directory as an extension and requires a default
 * factory export, so expose a no-op one here.
 */

import {
	AssistantMessageComponent,
	BashExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
	parseSkillBlock,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	ScrollView,
	VStack,
	type Component,
} from "@earendil-works/pi-tui";
import { toolsPanel } from "./split-panels.ts";
import { RowDivider } from "./split-render.ts";

// ─── response doc ─────────────────────────────────────────────────────────────

const responseDoc = new Container();
let streamingResponseComponent: AssistantMessageComponent | null = null;

/** TUI handle for BashExecutionComponent loaders (set from split.ts's widget). */
let bashUi: { requestRender: () => void } | null = null;
/** Live `!` blocks waiting for their branch entry (FIFO; matched by command). */
let liveBashPending: Array<{ command: string; comp: BashExecutionComponent }> = [];
/** Message objects already in the doc: the leaf walk must never double-add a
 * user/assistant message that message_start/update/end already streamed. */
let seenMessages = new WeakSet<object>();

export function setResponseTui(tui: unknown): void {
	bashUi =
		tui && typeof (tui as any).requestRender === "function"
			? (tui as { requestRender: () => void })
			: null;
}

/** Live theme for the doc's block dividers (set from split.ts's render loop). */
let responseTheme: Theme | null = null;

export function setResponseTheme(theme: Theme): void {
	responseTheme = theme;
}

/**
 * One block divider prefixed before a RESPONSE block (an assistant answer) in
 * the doc (user decision 2026-10-20: user messages are visually distinct and
 * bash blocks frame themselves, so only response blocks get the divider).
 * No-op when the doc is empty. SKIPS the boundary directly after a bash
 * block: its component ends in its own full-width ─ frame, and prefixing
 * another stroke would stack a double line (placement fix, measured in a
 * real tmux run). The theme is resolved lazily at render time, so a doc
 * rebuilt before the first render still shows its dividers.
 */
function addResponseDivider(): void {
	const kids = responseDoc.children as unknown[];
	if (kids.length === 0) return;
	if (kids[kids.length - 1] instanceof BashExecutionComponent) return;
	responseDoc.addChild(new RowDivider(() => responseTheme));
}

function messageText(msg: any): string {
	const c = msg?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c))
		return c
			.filter((p: any) => p?.type === "text" && typeof p.text === "string")
			.map((p: any) => p.text)
			.join("");
	return "";
}

/** Content with thinking blocks and tool calls stripped (response-only). */
function responseContent(msg: any): any[] {
	return (Array.isArray(msg?.content) ? msg.content : []).filter(
		(c: any) => c?.type !== "thinking" && c?.type !== "toolCall",
	);
}

/** Append a user or assistant message to the response doc. */
function addResponseMessage(msg: any): boolean {
	try {
		if (msg.role === "user") {
			const text = messageText(msg);
			if (!text.trim()) return false;
			const skill = safeSkillBlock(text);
			if (skill) {
				// Skill turn: the panel owns the invocation row; the doc shows
				// only the real user prompt, never the raw <skill …> block.
				toolsPanel.ingestEvent(
					`skill:${msg.timestamp ?? Date.now()}`,
					`skill: ${skill.name}`,
					skill.content,
				);
				if (!skill.userMessage) return true;
				responseDoc.addChild(
					new UserMessageComponent(skill.userMessage, getMarkdownTheme()),
				);
				return true;
			}
			responseDoc.addChild(new UserMessageComponent(text, getMarkdownTheme()));
			return true;
		}
		if (msg.role === "assistant") {
			const content = responseContent(msg);
			const hasText = content.some(
				(c: any) =>
					c?.type === "text" && typeof c.text === "string" && c.text.trim(),
			);
			// Keep empty-text messages whose stopReason shows an error marker.
			if (!hasText && msg.stopReason !== "error" && msg.stopReason !== "aborted")
				return false;
			addResponseDivider();
			// toolCalls are stripped too so the component's error/abort markers
			// render (it suppresses them when toolCalls exist — in the full
			// transcript the tool components show errors instead).
			responseDoc.addChild(
				new AssistantMessageComponent(
					{ ...msg, content },
					true,
					getMarkdownTheme(),
					"Thinking…",
					1,
					[],
				),
			);
			return true;
		}
	} catch {
		/* theme not ready yet — skipped; rebuilt on next reconstruct */
	}
	return false;
}

/** parseSkillBlock without ever throwing into an event/walk handler. */
function safeSkillBlock(text: string) {
	try {
		return parseSkillBlock(text);
	} catch {
		return null;
	}
}

/** One completed `!`/`!!` bash result as a doc block (native parity: the
 * component frames itself; no divider — user decision 2026-10-20). */
function addBashMessage(msg: any): boolean {
	const pending = bashComponentFor(msg.command);
	if (pending) {
		try {
			if (msg.output) pending.appendOutput(msg.output);
			pending.setComplete(
				msg.exitCode,
				msg.cancelled,
				msg.truncated ? { truncated: true } : undefined,
				msg.fullOutputPath,
			);
		} catch {
			/* fall through to the completed-block path below */
		}
		return true;
	}
	const comp = newBashComponent(msg.command, msg.excludeFromContext);
	if (!comp) return false;
	if (msg.output) comp.appendOutput(msg.output);
	comp.setComplete(
		msg.exitCode,
		msg.cancelled,
		msg.truncated ? { truncated: true } : undefined,
		msg.fullOutputPath,
	);
	responseDoc.addChild(comp);
	return true;
}

function newBashComponent(
	command: string,
	excludeFromContext: boolean,
): BashExecutionComponent | null {
	if (!bashUi) return null;
	try {
		return new BashExecutionComponent(command, bashUi, excludeFromContext, 1);
	} catch {
		return null;
	}
}

/** Pop the oldest live `!` block for this command (FIFO match), if any. */
function bashComponentFor(command: string): BashExecutionComponent | null {
	const i = liveBashPending.findIndex((p) => p.command === command);
	if (i === -1) return null;
	const [p] = liveBashPending.splice(i, 1);
	return p.comp;
}

// ─── branch ingestion (doc + panel events) ────────────────────────────────────

/**
 * Dispatch ONE branch entry to its owner: doc (user/assistant/bash) or the
 * Tool Usage panel (skill, compaction, branch summary, custom display
 * messages). Returns true when something was rendered/ingested.
 *
 * message roles user/assistant are exactly-once: the live message stream marks
 * them seen, and the leaf walk re-checks, so walk order vs message_start
 * order can never double-add.
 */
export function responseIngestEntry(entry: any): boolean {
	try {
		if (!entry) return false;
		if (entry.type === "message") {
			const msg = entry.message;
			if (!msg) return false;
			if (seenMessages.has(msg)) return false;
			if (msg.role === "user" || msg.role === "assistant") {
				seenMessages.add(msg);
				return addResponseMessage(msg);
			}
			if (msg.role === "bashExecution") return addBashMessage(msg);
			if (msg.role === "custom") {
				// Custom display message: panel event row, never doc noise.
				if (!msg.display) return false;
				const body =
					typeof msg.content === "string"
						? msg.content
						: safeJson(msg.content);
				toolsPanel.ingestEvent(
					entry.id,
					`custom: ${msg.customType ?? "message"}`,
					body,
				);
				return true;
			}
			return false; // toolResult/system: owned elsewhere or noise
		}
		if (entry.type === "compaction") {
			// Native parity: compaction clears the transcript; everything
			// before the compaction entry is summarized away.
			responseDoc.clear();
			streamingResponseComponent = null;
			toolsPanel.ingestEvent(
				entry.id,
				typeof entry.tokensBefore === "number"
					? `compaction (${entry.tokensBefore} tokens)`
					: "compaction",
				typeof entry.summary === "string" ? entry.summary : undefined,
			);
			return true;
		}
		if (entry.type === "branch_summary" && entry.summary) {
			toolsPanel.ingestEvent(entry.id, "branch summary", entry.summary);
			return true;
		}
		if (entry.type === "custom_message" && entry.display) {
			const body =
				typeof entry.content === "string" ? entry.content : safeJson(entry.content);
			toolsPanel.ingestEvent(
				entry.id,
				`custom: ${entry.customType ?? "message"}`,
				body,
			);
			return true;
		}
		return false; // custom entries, usage, thinking_level_change, …
	} catch {
		/* ingestion must never break a walk or an event handler */
		return false;
	}
}

function safeJson(v: unknown): string | undefined {
	try {
		return JSON.stringify(v);
	} catch {
		return undefined;
	}
}

// ─── rebuild (session start / tree switch / theme change) ─────────────────────

/** Begin a full doc rebuild: clear everything, fresh seen-message set. */
export function responseDocBegin(): void {
	responseDoc.clear();
	streamingResponseComponent = null;
	liveBashPending = [];
	seenMessages = new WeakSet<object>();
}

/** End a full rebuild: park the leaf cursor so the per-frame walk starts clean. */
export function responseDocEnd(ctx: ExtensionContext): void {
	markBranchCursor(ctx);
}

/** Rebuild the whole response doc from the current branch (start / reload / tree switch). */
export function rebuildResponseDoc(ctx: ExtensionContext): void {
	responseDocBegin();
	for (const entry of ctx.sessionManager.getBranch())
		responseIngestEntry(entry);
	responseDocEnd(ctx);
}

// ─── live leaf walk (no extension events exist for these appends) ─────────────

/** Leaf entry id already ingested by rebuild or a previous walk. */
let cursorLeafId: string | null = null;

export function markBranchCursor(ctx: ExtensionContext): void {
	try {
		cursorLeafId = (ctx.sessionManager as any).getLeafId?.() ?? null;
	} catch {
		cursorLeafId = null;
	}
}

/** Drop live-walk state (session shutdown / extension teardown). */
export function resetResponseState(): void {
	cursorLeafId = null;
	liveBashPending = [];
	responseDoc.clear();
	streamingResponseComponent = null;
	seenMessages = new WeakSet<object>();
}

/**
 * Ingest branch entries appended since the cursor. Called once per TUI frame
 * from split.ts's widget render loop: getLeafId() is an O(1) string compare
 * when nothing changed. When the leaf moved, walk parent links from the new
 * leaf back to the cursor (oldest-first ingest). If the cursor is not on the
 * ancestry (tree switch without a session_tree rebuild), no-op — the rebuild
 * owns that case. Returns true when anything was ingested (caller repaints).
 */
export function syncBranchEntries(ctx: ExtensionContext): boolean {
	const sm = ctx.sessionManager as any;
	if (typeof sm?.getLeafId !== "function" || typeof sm?.getEntry !== "function")
		return false;
	const leafId: string | undefined = sm.getLeafId();
	if (!leafId || leafId === cursorLeafId) return false;
	if (cursorLeafId === null) {
		// No rebuild ran yet (should not happen — reconstruct parks the
		// cursor): start the cursor without ingesting history twice.
		cursorLeafId = leafId;
		return false;
	}
	const fresh: any[] = [];
	let id: string | undefined = leafId;
	let reachedCursor = false;
	let guard = 0;
	while (id && guard++ < 100000) {
		if (id === cursorLeafId) {
			reachedCursor = true;
			break;
		}
		const entry = sm.getEntry(id);
		if (!entry) break;
		fresh.push(entry);
		id = entry.parentId;
	}
	cursorLeafId = leafId;
	if (!reachedCursor) return false;
	let any = false;
	for (let i = fresh.length - 1; i >= 0; i--)
		if (responseIngestEntry(fresh[i])) any = true;
	return any;
}

// ─── live message stream (message_start/update/end) ───────────────────────────

/** message_start (user messages get added; assistant handled on update). */
export function responseMessageStart(msg: unknown): void {
	const m = msg as any;
	if (m?.role !== "user") return;
	if (seenMessages.has(m)) return;
	seenMessages.add(m);
	addResponseMessage(m);
}

/** Live-stream an assistant message into the doc (lazy: created on first visible text). */
export function responseMessageUpdate(msg: unknown): void {
	if ((msg as any)?.role !== "assistant") return;
	const stripped = { ...(msg as any), content: responseContent(msg) };
	const hasVisible = stripped.content.some(
		(c: any) => c?.type === "text" && typeof c.text === "string" && c.text.trim(),
	);
	if (!streamingResponseComponent) {
		// Pure tool-call / thinking rounds never create a component — no stray
		// spacers accumulate in the doc.
		if (!hasVisible) return;
		try {
			addResponseDivider();
			streamingResponseComponent = new AssistantMessageComponent(
				undefined as any,
				true,
				getMarkdownTheme(),
				"Thinking…",
				1,
				[],
			);
			responseDoc.addChild(streamingResponseComponent);
		} catch {
			/* theme not ready */
			return;
		}
	}
	try {
		streamingResponseComponent.updateContent(stripped, true);
	} catch {
		/* ignore */
	}
}

export function responseMessageEnd(msg: unknown): void {
	const m = msg as any;
	if (m?.role !== "assistant") return;
	// Mark seen FIRST: the leaf walk re-checks, so this message can never be
	// double-added no matter which of the two paths renders it.
	seenMessages.add(m);
	if (streamingResponseComponent) {
		try {
			streamingResponseComponent.updateContent(
				{ ...m, content: responseContent(m) },
				false,
			);
		} catch {
			/* ignore */
		}
		streamingResponseComponent = null;
	} else {
		// No component was streamed (no update fired, or thinking/tool-only
		// round): finalize from the full message — the ingest path itself
		// skips empty text and keeps error/abort markers.
		addResponseMessage(m);
	}
}

// ─── live bash start (user_bash) ──────────────────────────────────────────────

/**
 * A `!`/`!!` command started. Adds a running block ($ command + spinner) to
 * the doc; the per-frame leaf walk completes it from the appended branch
 * entry (output + exit status). MUST be called from a user_bash handler that
 * never throws and returns undefined (pi aborts the command otherwise).
 */
export function startLiveBash(command: string, excludeFromContext: boolean): void {
	const comp = newBashComponent(command, excludeFromContext);
	if (!comp) return;
	responseDoc.addChild(comp);
	liveBashPending.push({ command, comp });
}

// ─── layout ──────────────────────────────────────────────────────────────────

/**
 * The ONE ScrollView over the response doc. Retained across toggles and
 * branch switches so the numeric scroll offset is preserved/clamped across
 * rebuilds — never recreated (see the singleton discipline in the header).
 */
let responseScrollView: ScrollView | null = null;

/** The retained response ScrollView singleton (null before the first trim compose). */
export function getResponseScrollView(): ScrollView | null {
	return responseScrollView;
}

/** The response doc (user + assistant text components), owned by this module. */
export function getResponseDoc(): Container {
	return responseDoc;
}

/**
 * Extract the input dock from pi's base root. The base root is a
 * VStack[transcriptScrollView, dock]: the transcript entry holds a ScrollView
 * (own `child` property); the input dock entry's component has no own
 * `child`, so the entry without `child` is the input dock.
 */
export function baseDockOf(base: any): Component | null {
	const entries = base?.entries;
	if (!Array.isArray(entries)) return null;
	// The transcript entry holds the ScrollView (own `child`); the input dock is the
	// other entry.
	for (const e of entries) {
		const c = e?.component;
		if (!c) continue;
		if (!Object.hasOwn(c, "child")) return c as Component; // not a ScrollView → input dock
	}
	return null;
}

/**
 * Build the response-only inner root: VStack([responseScrollView, dock]).
 * The dock (pending/status/editor/widgets/footer) is reused verbatim from the
 * base root, so input is untouched. Returns null if the dock cannot be
 * extracted (caller fails loudly). The ScrollView is a retained singleton;
 * do not recreate it across calls.
 */
export function buildResponseInner(
	theme: Theme,
	base: Component | null,
): Component | null {
	if (!base) return null;
	const dock = baseDockOf(base);
	if (!dock) return null;
	if (!responseScrollView) {
		responseScrollView = new ScrollView(responseDoc, {
			follow: "end",
			overscroll: "chain",
			scrollbar: "auto",
			scrollbarTrackStyle: (t: string) => theme.fg("dim", t),
			scrollbarThumbStyle: (t: string) => theme.fg("accent", t),
		});
	}
	return new VStack([
		{ component: responseScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
}
