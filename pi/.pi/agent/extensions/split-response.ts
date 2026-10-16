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
 * The doc lives under ONE retained ScrollView singleton. The instance is
 * created once and NEVER recreated across toggles or branch switches, so the
 * NUMERIC scroll offset is preserved (and clamped into new content) across
 * rebuilds — exactly like the native transcript on the same /tree switch.
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
	UserMessageComponent,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	ScrollView,
	Spacer,
	VStack,
	type Component,
} from "@earendil-works/pi-tui";

// ─── response doc ─────────────────────────────────────────────────────────────

/**
 * The response document: user + assistant messages only, rendered with pi's
 * own transcript components. Built from the branch (session start / tree) and
 * streamed live (message_start/update/end). Assistant content is filtered to
 * drop thinking blocks (the thinking panel owns those) — tool calls never
 * render here (the tool panel owns those), so an assistant message with no
 * text is skipped.
 */
const responseDoc = new Container();
let streamingResponseComponent: AssistantMessageComponent | null = null;

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

/** Append a message to the response doc (user or assistant). */
function addResponseMessage(msg: any): void {
	try {
		if (msg.role === "user") {
			const text = messageText(msg);
			if (!text.trim()) return;
			if (responseDoc.children.length > 0) responseDoc.addChild(new Spacer(1));
			responseDoc.addChild(new UserMessageComponent(text, getMarkdownTheme()));
			return;
		}
		if (msg.role === "assistant") {
			const content = responseContent(msg);
			const hasText = content.some(
				(c: any) =>
					c?.type === "text" && typeof c.text === "string" && c.text.trim(),
			);
			// Keep empty-text messages whose stopReason shows an error marker.
			if (!hasText && msg.stopReason !== "error" && msg.stopReason !== "aborted")
				return;
			if (responseDoc.children.length > 0) responseDoc.addChild(new Spacer(1));
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
		}
	} catch {
		/* theme not ready yet — skipped; rebuilt on next reconstruct */
	}
}

/** Rebuild the whole response doc from the current branch (start / reload / tree switch). */
export function rebuildResponseDoc(ctx: ExtensionContext): void {
	responseDoc.clear();
	streamingResponseComponent = null;
	const branch = ctx.sessionManager.getBranch();
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const msg = (entry as any).message;
		if (msg) addResponseMessage(msg);
	}
}

/** message_start (user messages get added; assistant handled on update). */
export function responseMessageStart(msg: unknown): void {
	if ((msg as any)?.role === "user") addResponseMessage(msg);
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
			if (responseDoc.children.length > 0) responseDoc.addChild(new Spacer(1));
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
	if ((msg as any)?.role !== "assistant") return;
	if (streamingResponseComponent) {
		try {
			streamingResponseComponent.updateContent(
				{ ...(msg as any), content: responseContent(msg) },
				false,
			);
		} catch {
			/* ignore */
		}
		streamingResponseComponent = null;
	} else {
		// No component was streamed (no update fired, or thinking/tool-only
		// round): finalize from the full message — addResponseMessage itself
		// skips empty text and keeps error/abort markers.
		addResponseMessage(msg);
	}
}

// ─── layout ──────────────────────────────────────────────────────────────────

/**
 * The ONE ScrollView over the response doc. Retained across toggles and
 * branch switches so the numeric scroll offset is preserved/clamped across
 * rebuilds — never recreated (see the singleton discipline in the header).
 */
let responseScrollView: ScrollView | null = null;

/**
 * Extract the editor dock from pi's base root. The base root is a
 * VStack[transcriptScrollView, dock]: the transcript entry holds a ScrollView
 * (own `child` property); the dock entry's component has no own `child`, so
 * the entry without `child` is the dock.
 */
export function baseDockOf(base: any): Component | null {
	const entries = base?.entries;
	if (!Array.isArray(entries)) return null;
	// The transcript entry holds the ScrollView (own `child`); the dock is the
	// other entry.
	for (const e of entries) {
		const c = e?.component;
		if (!c) continue;
		if (!Object.hasOwn(c, "child")) return c as Component; // not a ScrollView → dock
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

/** Default no-op factory: this module is shared, not an extension. */
export default function (_pi: ExtensionAPI): void {
	/* no-op: shared response-view module, not an extension */
}
