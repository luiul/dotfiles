/**
 * split-panels.ts — stateful data buffers for the split extension's two
 * streaming panels: thinking (panel A) and tool usage (panel B).
 *
 * This module is the data-logic half of the retired upstream extension
 * split-view.ts, ported when we replaced it with our own split layout
 * (split.ts + split-layout.ts + split-render.ts + split-config.ts). It holds
 * ONLY the bounded buffers, ingestion, and logical-line rendering of the two
 * streaming panels — composition, drag, commands, and event wiring live in
 * split.ts, which owns the layout slots (split-layout.ts) and the compact
 * framed-panel look (split-render.ts).
 *
 * Single-session-per-process assumption (inherited from upstream SV-20): the
 * buffers are module-level singletons, one set per pi process, exactly like
 * upstream split-view.ts held them. The panels bump their versions on
 * coalesced 100ms timers (streaming appends / streaming tool output would
 * otherwise re-wrap whole windows per token); split.ts registers its
 * requestRender hook once at session start via setPanelRenderHook so flushes
 * trigger a repaint without this module knowing about the TUI.
 *
 * Upstream invariants preserved verbatim (SV-xx numbered comments record real
 * decisions; see the retired split-view.ts for full history):
 *   SV-16 — storage caps (32 KiB newest-suffix tool text, 20 output lines)
 *            are applied BEFORE splitting, so splits never see unbounded text.
 *   SV-17 — live events and branch reconstruction ingest through the SAME
 *            path, so resumed and live entries behave identically.
 *   SV-21 — an empty/omitted thinking end() payload must not wipe streamed
 *            text; the accumulated tail is finalized into the current block.
 *
 * This module is shared, not an extension. pi auto-discovers every *.ts file
 * in this directory as an extension and requires a default factory export,
 * so expose a no-op one here.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

// ─── render hook (registered by split.ts at session start) ───────────────────

/**
 * The panels bump versions on coalesced timers and need to trigger a repaint.
 * split.ts owns the TUI reference, so it registers its requestRender here
 * once at session start (and may pass null to detach, e.g. on shutdown).
 */
let renderHook: (() => void) | null = null;

export function setPanelRenderHook(fn: (() => void) | null): void {
	renderHook = fn;
}

// ─── thinking buffer ─────────────────────────────────────────────────────────

interface ThinkingBlock {
	lines: string[];
	tail: string;
	complete: boolean;
}

/**
 * Coalesce streaming appends: each token bumps `version`, which invalidates the
 * panel's (version, width) render cache → full re-wrap of all lines per frame.
 * During a stream we bump at most every THINK_RAF_MS instead, so keystroke
 * frames don't queue behind 5000-line re-wraps. Complete blocks + end() are
 * unaffected (they bump synchronously).
 */
const THINK_RAF_MS = 100;
let thinkFlushTimer: ReturnType<typeof setTimeout> | null = null;
let thinkDirty = false;

function flushThinking(): void {
	thinkFlushTimer = null;
	if (!thinkDirty) return;
	thinkDirty = false;
	thinkVersionCounter++;
	renderHook?.();
}

function cancelPendingThinkFlush(): void {
	thinkDirty = false;
	if (thinkFlushTimer) {
		clearTimeout(thinkFlushTimer);
		thinkFlushTimer = null;
	}
}

let thinkVersionCounter = 0;

/**
 * Display window (logical lines) for the thinking panel. The full transcript
 * keeps everything; the panel is a recent-history view. Must stay small: the
 * per-flush render cost is dominated by wrapping the visible window.
 */
const MAX_LINES = 400;
/**
 * A newline-free streaming tail grows char by char; every flush re-wraps it
 * (its key changes each time). Render only its recent suffix so per-flush
 * work is bounded even for one giant paragraph.
 */
const MAX_TAIL_CHARS = 2000;

const thinkingState = {
	blocks: [] as ThinkingBlock[],
	current: null as ThinkingBlock | null,
	streaming: false,
	start() {
		if (this.current && (this.current.lines.length || this.current.tail)) {
			this.current.complete = true;
			this.blocks.push(this.current);
		}
		this.current = { lines: [], tail: "", complete: false };
		this.streaming = true;
		thinkVersionCounter++;
	},
	append(delta: string) {
		if (!this.current) this.current = { lines: [], tail: "", complete: false };
		this.current.tail += delta;
		if (this.current.tail.length > MAX_TAIL_CHARS)
			this.current.tail = this.current.tail.slice(-MAX_TAIL_CHARS);
		let nl = this.current.tail.indexOf("\n");
		while (nl !== -1) {
			this.current.lines.push(this.current.tail.slice(0, nl));
			this.current.tail = this.current.tail.slice(nl + 1);
			nl = this.current.tail.indexOf("\n");
		}
		this.trim();
		thinkDirty = true;
		if (!thinkFlushTimer)
			thinkFlushTimer = setTimeout(flushThinking, THINK_RAF_MS);
	},
	end(text: string) {
		cancelPendingThinkFlush();
		if (this.current) {
			if (text) {
				// Authoritative final content: replace the accumulated buffer.
				this.current.lines = text.split(/\r?\n/);
				this.current.tail = "";
			} else if (this.current.tail) {
				// SV-21: an empty/omitted end payload must not wipe streamed
				// text — finalize the accumulated tail into the current block.
				this.current.lines.push(this.current.tail);
				this.current.tail = "";
			}
			this.current.complete = true;
			this.blocks.push(this.current);
			this.current = null;
			this.trim();
		}
		this.streaming = false;
		thinkVersionCounter++;
	},
	trim() {
		// Hard-bound the whole display buffer (oldest lines first, splicing
		// partially into the front/current block so a giant block trims instead
		// of vanishing). The old version only evicted whole completed blocks, so
		// an oversized current block or reconstruct() output could blow past
		// MAX_LINES.
		let excess = this.countLines() - MAX_LINES;
		while (excess > 0) {
			const b = this.blocks[0];
			if (!b) {
				if (this.current) {
					const cut = Math.min(excess, this.current.lines.length);
					this.current.lines.splice(0, cut);
					excess -= cut;
				}
				break;
			}
			if (b.lines.length <= excess) {
				this.blocks.shift();
				excess -= b.lines.length;
			} else {
				b.lines.splice(0, excess);
				excess = 0;
			}
		}
	},
	countLines() {
		let total = 0;
		for (const b of this.blocks) total += b.lines.length;
		if (this.current) total += this.current.lines.length;
		return total;
	},
	reset() {
		cancelPendingThinkFlush();
		this.blocks = [];
		this.current = null;
		this.streaming = false;
		thinkVersionCounter++;
	},
};

/**
 * Thinking panel body, LOGICAL lines (split-render.ts's RecentBody does the
 * wrapping/truncation/windowing). Newest content lands at the bottom: completed
 * blocks first (dim ─ separator between blocks), then the streaming current
 * block with its live tail as the last line.
 */
function thinkingLines(theme: Theme, width: number): string[] {
	const out: string[] = [];
	const sep = theme.fg("dim", "─".repeat(Math.max(8, Math.min(60, width - 3))));
	for (const b of thinkingState.blocks) {
		if (out.length) out.push("");
		out.push(sep);
		for (const l of b.lines) out.push(l);
	}
	if (thinkingState.current) {
		if (out.length) out.push("");
		for (const l of thinkingState.current.lines) out.push(l);
		if (thinkingState.current.tail) out.push(thinkingState.current.tail);
	}
	return out;
}

export interface ThinkingPanelApi {
	start(): void;
	append(delta: string): void;
	/** Authoritative final content replaces the accumulated stream. */
	end(text: string): void;
	reset(): void;
	version(): number;
	streaming(): boolean;
	lines(theme: Theme, width: number): string[];
}

export const thinkingPanel: ThinkingPanelApi = {
	start: () => thinkingState.start(),
	append: (delta: string) => thinkingState.append(delta),
	end: (text: string) => thinkingState.end(text),
	reset: () => thinkingState.reset(),
	version: () => thinkVersionCounter,
	streaming: () => thinkingState.streaming,
	lines: (theme: Theme, width: number) => thinkingLines(theme, width),
};

// ─── tool buffer ─────────────────────────────────────────────────────────────

/**
 * Tools-side twin of the thinking flush: tool_execution_update can fire many
 * times per second while a command streams output; each bump would re-wrap
 * the tools window + repaint. Coalesce to ≤1 version bump per TOOLS_FLUSH_MS.
 * start/end stay synchronous (entry appears / finalizes immediately).
 */
const TOOLS_FLUSH_MS = 100;
let toolsFlushTimer: ReturnType<typeof setTimeout> | null = null;
let toolsDirty = false;

let toolsVersionCounter = 0;

function flushTools(): void {
	toolsFlushTimer = null;
	if (!toolsDirty) return;
	toolsDirty = false;
	toolsVersionCounter++;
	renderHook?.();
}

function cancelPendingToolsFlush(): void {
	toolsDirty = false;
	if (toolsFlushTimer) {
		clearTimeout(toolsFlushTimer);
		toolsFlushTimer = null;
	}
}

function markToolsDirty(): void {
	toolsDirty = true;
	if (!toolsFlushTimer) toolsFlushTimer = setTimeout(flushTools, TOOLS_FLUSH_MS);
}

interface ToolEntry {
	id: string;
	name: string;
	args: string;
	output: string;
	active: boolean;
	isError: boolean;
	subagent?: boolean;
	agent?: string;
	/** Present on session-event rows (skill / compaction / branch summary /
	 * custom): rendered with the event glyph instead of the tool status mark,
	 * `name` is the event title, `output` the optional body. Never active. */
	event?: boolean;
}
const toolsBy = new Map<string, ToolEntry>();
const toolOrder: string[] = [];

/** Newest-first display cap: oldest entries are evicted beyond this. */
const MAX_TOOLS = 60;
/** Newest-lines suffix cap on one tool's stored output (logical lines). */
const MAX_TOOL_OUTPUT_LINES = 20;

/** True if c is a UTF-16 high (lead) surrogate — the first half of an astral
 * code point. Used to keep truncation cuts off surrogate-pair boundaries. */
function isHighSurrogate(c: number): boolean {
	return c >= 0xd800 && c <= 0xdbff;
}

function truncateInline(s: string, max = 40): string {
	const flat = s.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	let end = max - 1;
	// Never end mid surrogate pair (a lone trailing half renders as U+FFFD).
	if (end >= 1 && isHighSurrogate(flat.charCodeAt(end - 1))) end--;
	return flat.slice(0, end) + "…";
}

/** SV-16: storage cap for one tool's text (args JSON or result output), in
 * UTF-16 code units (≈ in-memory size of the stored string). Below pi's own
 * bash-output cap (50KB) so even maximal tool output is bounded here, and
 * ~2.7× the maximum displayed content (20 lines × 600 chars). */
const MAX_TOOL_TEXT_CHARS = 32 * 1024;

/** SV-16: bound one tool text to MAX_TOOL_TEXT_CHARS, keeping the NEWEST
 * suffix and prepending an explicit truncation marker. The cut is aligned to
 * a code point so a UTF-16 surrogate pair is never split. Text within the
 * cap passes through unchanged (byte-identical). */
function capToolText(s: string): string {
	if (s.length <= MAX_TOOL_TEXT_CHARS) return s;
	const total = s.length;
	const marker = `[truncated: newest ${MAX_TOOL_TEXT_CHARS} of ${total} chars]\n`;
	const budget = MAX_TOOL_TEXT_CHARS - marker.length;
	let end = s.length;
	let units = 0;
	while (end > 0 && units < budget) {
		// Width of the code point ENDING at `end`: an astral char occupies
		// end-2..end-1 (lead surrogate at end-2), so a pair is never split.
		const w = end >= 2 && isHighSurrogate(s.charCodeAt(end - 2)) ? 2 : 1;
		if (units + w > budget) break;
		units += w;
		end -= w;
	}
	return marker + s.slice(end);
}

function resultText(r: any): string {
	let text: string;
	if (typeof r === "string") text = r;
	else {
		const content = r?.content;
		if (typeof content === "string") text = content;
		else if (Array.isArray(content)) {
			text = content
				.filter((c: any) => c?.type === "text" && typeof c.text === "string")
				.map((c: any) => c.text)
				.join("");
		} else text = "";
	}
	// SV-16: bound the stored text before the caller splits/keeps lines.
	return capToolText(text);
}

function argsJson(args: any): string {
	try {
		// SV-16: bound the stored args JSON (newest suffix + marker).
		return capToolText(JSON.stringify(args ?? {}));
	} catch {
		return "";
	}
}

function setToolOutput(e: ToolEntry, text: string): void {
	// SV-16: cap BEFORE splitting so the split never sees unbounded text.
	const lines = capToolText(text).split(/\r?\n/);
	e.output = lines.slice(-MAX_TOOL_OUTPUT_LINES).join("\n");
}

/** SV-17: ingest one tool call through the SAME path for live events and
 * branch reconstruction (resume / session_tree), so the bounded buffer,
 * the newest-first display and the MAX_TOOLS eviction (oldest shifted out)
 * behave identically for resumed and live entries. */
function ingestToolCall(id: string, name: string, args: any): void {
	toolOrder.push(id);
	toolsBy.set(id, {
		id,
		name,
		args: argsJson(args),
		output: "",
		active: true,
		isError: false,
	});
	toolsVersionCounter++;
	if (toolOrder.length > MAX_TOOLS) {
		const evict = toolOrder.shift()!;
		toolsBy.delete(evict);
	}
}

/** SV-17: ingest one tool result, correlated to its call by id (live event
 * or resumed branch entry). A result whose call is not in the bounded buffer
 * (evicted or unknown) is ignored. */
function ingestToolResult(id: string, result: any, isError: boolean): void {
	const e = toolsBy.get(id);
	if (!e) return;
	const text = resultText(result);
	if (text) setToolOutput(e, text);
	e.active = false;
	e.isError = isError;
	cancelPendingToolsFlush();
	toolsVersionCounter++;
}

/** Detail mode for the tools body: compact (status + name + args preview) or
 * full (adds up to 2 output lines + "+N more"). Session-local; split.ts
 * initializes it from split-config.ts and owns persistence. */
let toolMode: "compact" | "full" = "compact";

function toolLines(theme: Theme, width: number): string[] {
	const th = theme;
	const out: string[] = [];
	const full = toolMode === "full";
	// Text budget inside the frame: 1 col inset + ≥2 trailing pad cols
	// (the transient scrollbar paints over the pad, never the frame).
	const textWidth = Math.max(8, width - 3);
	for (const id of toolOrder) {
		const e = toolsBy.get(id);
		if (!e) continue;
		// Session events (user decision 2026-10-24): one compact line with a
		// muted glyph, body detail only in full mode — the panel is the
		// action/event log, so events read like rows, not tool calls.
		if (e.event) {
			const glyph = th.fg("muted", "◆");
			const title = th.fg("text", e.name);
			out.push(`${glyph} ${title}`);
			if (!full) continue;
			const content = (e.output || "")
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter(Boolean);
			for (const l of content.slice(0, 2))
				out.push(th.fg("toolOutput", `  · ${truncateInline(l, textWidth - 4)}`));
			if (content.length > 2)
				out.push(th.fg("dim", `  · +${content.length - 2} more`));
			continue;
		}
		const mark = e.active
			? th.fg("warning", "●")
			: e.isError
				? th.fg("error", "✗")
				: th.fg("success", "✓");
		const name = e.active
			? th.fg("accent", e.name)
			: e.isError
				? th.fg("error", e.name)
				: th.fg("success", e.name);
		const badge = e.subagent ? th.fg("muted", `[${e.agent ?? "sub"}]`) : "";
		const prefix = `${mark} ${name}${badge}`;
		const room = textWidth - visibleWidth(prefix) - 1;
		const args =
			e.args && room >= 8
				? th.fg("muted", ` ${truncateInline(e.args, room)}`)
				: "";
		out.push(prefix + args);
		if (!full) {
			// Compact: entries are adjacent, no blank separator rows (user
			// decision 2026-10-16 — the status mark + colored name is enough
			// visual separation, and the panel shows more entries per screen).
			continue;
		}
		const content = (e.output || "")
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);
		if (content.length === 0) {
			if (e.active) out.push(th.fg("dim", "  · …"));
		} else {
			for (const l of content.slice(0, 2))
				out.push(th.fg("toolOutput", `  · ${truncateInline(l, textWidth - 4)}`));
			if (content.length > 2)
				out.push(th.fg("dim", `  · +${content.length - 2} more`));
		}
	}
	return out;
}

export interface ToolsPanelApi {
	ingestCall(id: string, name: string, args: unknown): void;
	ingestUpdate(id: string, partial: unknown): void;
	ingestResult(id: string, result: unknown, isError?: boolean): void;
	ingestSubagent(name: string, args: unknown, agent?: string): void;
	/** Ingest a session event row (skill / compaction / branch summary /
	 * custom message). `id` dedupes (use the branch entry id when one
	 * exists); `title` is the compact line, `body` optional detail for full
	 * mode. */
	ingestEvent(id: string, title: string, body?: string): void;
	reset(): void;
	version(): number;
	/** Any tool call currently active (drives the tools header's streaming dot). */
	activeAny(): boolean;
	setMode(mode: "compact" | "full"): void;
	getMode(): "compact" | "full";
	lines(theme: Theme, width: number): string[];
}

export const toolsPanel: ToolsPanelApi = {
	ingestCall(id, name, args) {
		try {
			ingestToolCall(id, name, args);
		} catch {
			/* ingestion must never break the event listener */
		}
	},
	ingestUpdate(id, partial) {
		try {
			const e = toolsBy.get(id);
			if (!e) return;
			setToolOutput(e, resultText(partial));
			markToolsDirty();
		} catch {
			/* ingestion must never break the event listener */
		}
	},
	ingestResult(id, result, isError = false) {
		try {
			ingestToolResult(id, result, isError);
		} catch {
			/* ingestion must never break the event listener */
		}
	},
	ingestSubagent(name, args, agent) {
		try {
			// Mirrors upstream's pi.events "subagents:tool_call" ingestion: a
			// tool entry with a subagent badge and its agent name, marked done
			// immediately (the subagent's own progress is not streamed here).
			const id = `sub:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
			toolOrder.push(id);
			toolsBy.set(id, {
				id,
				name,
				args: argsJson(args),
				output: "",
				active: false,
				isError: false,
				subagent: true,
				agent,
			});
			toolsVersionCounter++;
			if (toolOrder.length > MAX_TOOLS) {
				const evict = toolOrder.shift()!;
				toolsBy.delete(evict);
			}
		} catch {
			/* ingestion must never break the event listener */
		}
	},
	ingestEvent(id, title, body) {
		try {
			if (toolsBy.has(id)) return; // dedupe (branch entry id is stable)
			toolOrder.push(id);
			toolsBy.set(id, {
				id,
				name: title,
				args: "",
				output: body ? capToolText(body) : "",
				active: false,
				isError: false,
				event: true,
			});
			toolsVersionCounter++;
			if (toolOrder.length > MAX_TOOLS) {
				const evict = toolOrder.shift()!;
				toolsBy.delete(evict);
			}
		} catch {
			/* ingestion must never break the event listener */
		}
	},
	reset() {
		// Upstream's reconstruct() path: clear the bounded buffer and bump the
		// version so the (version, width) render cache invalidates.
		cancelPendingToolsFlush();
		toolsBy.clear();
		toolOrder.length = 0;
		toolsVersionCounter++;
	},
	version: () => toolsVersionCounter,
	activeAny: () => toolOrder.some((id) => toolsBy.get(id)?.active),
	setMode(mode) {
		if (mode === toolMode) return;
		toolMode = mode;
		// Display change: invalidate the body's (version, width) cache and
		// repaint (upstream recomposed the panel on the toggle instead).
		toolsVersionCounter++;
		renderHook?.();
	},
	getMode: () => toolMode,
	lines: (theme: Theme, width: number) => toolLines(theme, width),
};

/**
 * This module is a shared utility imported by split.ts. pi auto-discovers
 * every *.ts file in this directory as an extension and requires a default
 * factory export, so expose a no-op one here.
 */
export default function (_pi: ExtensionAPI): void {
	/* no-op: shared panel-data module, not an extension */
}
