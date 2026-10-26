/**
 * zen.ts v2 — one-line, collapsible tool calls for bare pi.
 *
 *   ┌ transcript ────────────────────────────────────────────────────┐
 *   │ ▸ user prompt                                                   │
 *   │   Thinking...                      ← native (hideThinkingBlock)  │
 *   │ ▸ assistant text                                                 │
 *   │   $ git status ✓ (0.4s)            ← one line, native success bg │
 *   │   $ cat missing.txt ✗ cat: missing.txt: … (2.1s)  ← error, red bg│
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Every collapsed text call stays visible as one physical row plus Pi's
 * separator. Width-aware previews keep filenames, read ranges, MCP operations,
 * status and structured warnings. Images stay visible and owned by Pi.
 * Click or Ctrl+O restores full native details; arguments and results never change.
 *
 * Built entirely on pi's public tool renderer API:
 * - `pi.registerToolRenderer((toolName, next) => renderers)` chooses the
 *   renderers for every tool, including MCP tools (extensions.md,
 *   "Tool rendering"). The resolver runs once per tool block; zen's
 *   wrappers consult the toggle on every render, so /zen flips the whole
 *   transcript at runtime.
 * - Collapsed-vs-expanded state is native: ToolExecutionComponent wraps
 *   every block in a click region and passes `context.expanded` to the
 *   renderers; `ctrl+o` (app.tools.expand) toggles it too.
 * - Collapsed success renders an empty Container (zero rows) — pi's own
 *   read renderer uses the same trick for skills and docs files, so this
 *   is a native pattern, not a hack.
 * - The public renderShell: "self" removes native box padding in compact mode.
 *   Expanded and toggle-off views use public Box framing around native renderers.
 *   Pending, success and error backgrounds still use Pi's theme tokens.
 * - Thinking is fully native: the `hideThinkingBlock` setting collapses
 *   it, ctrl+t peeks at one message. Zen v1's thinking code is gone.
 *
 * The one-line status suffix: the call and result renderers share the
 * per-block `context.state` object (the same mechanism pi's bash timer
 * uses). renderResult stores {ok, durationMs, errLine} there once a
 * final result arrives and updates the shared compact row before Pi paints.
 * No deferred or synchronous invalidate is needed for the suffix.
 *
 * Per-tool call lines use cached summaries in compact mode. Commands flatten
 * line breaks; paths are relative where possible and shorten from the tail.
 * Narrow error rows drop timing before error detail. Expanded rendering delegates
 * to native components. Collapsed calls do not start native running timers.
 *
 * Toggle: `/zen [on|off]` or ctrl+alt+t, persisted in ~/.pi/agent/zen.json
 * (`filter`, default on). Off returns `next()` unchanged for new blocks
 * and delegates through the wrappers for existing ones, so the off state
 * is byte-exact native. Refreshing existing blocks after a toggle uses a
 * registry of the per-block invalidate closures (context.invalidate is
 * public API) instead of walking the layout: cleared on session_start,
 * session_tree, and compaction, which rebuild all blocks anyway.
 *
 * Failure policy: fail-open. Every native delegation is wrapped; if a pi
 * upgrade changes a renderer's shape, pi's own updateDisplay catch falls
 * back to its built-in rendering (the block shows native detail). Zen
 * never throws into pi's render path.
 *
 * Overhead: collapsed layout is cached by argument values, theme colors,
 * final status and width. Collapsed partial results stay hidden. Native renderers
 * used while expanded receive one final cleanup pass. Unknown expanded output uses one framed
 * Text like Pi's fallback; registered generic tools keep native fallback slots.
 * Benchmark actual components with scripts/bench-zen-renderers.ts, including
 * shared state and native cleanup.
 *
 * Scope: interactive fullscreen TUI. In other modes renderers are never
 * invoked, so the extension is inert by construction.
 *
 * Decisions and history: luiul/dotfiles#67 (v1 was a hide-based filter;
 * v2 replaces it — all calls visible, one line, collapsible).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import {
	Box, Text, getCapabilities, getImageDimensions, getKeybindings, imageFallback,
	stripTerminalSequences, truncateToWidth, sliceByColumn, visibleWidth as terminalWidth,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── config ──────────────────────────────────────────────────────────────────

let CONFIG_PATH = path.join(homedir(), ".pi", "agent", "zen.json");

/** Test seam (repo convention): point the config file at a temp path. */
export function __setConfigPathForTest(p: string): void {
	CONFIG_PATH = p;
}

/**
 * Compact mode for new sessions. Strict typing: only a real boolean counts,
 * so bad JSON can never flip the mode accidentally. Defaults to ON.
 */
export function loadFilterOn(): boolean {
	try {
		const raw: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
			const filter = (raw as { filter?: unknown }).filter;
			if (typeof filter === "boolean") return filter;
		}
	} catch {
		/* missing or bad file: default below */
	}
	return true;
}

/** Persist the toggle. Returns whether the write actually succeeded. */
export function saveFilterOn(on: boolean): boolean {
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify({ filter: on }, null, 2) + "\n");
		return true;
	} catch {
		return false;
	}
}

// ─── status suffix helpers (pure; exported for unit tests) ──────────────────

/** ANSI escape removal, so visible-width math works on styled text. */
export function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Visible terminal columns, including wide and combining characters. */
export function visibleWidth(text: string): number {
	return terminalWidth(text);
}

/** Truncate plain (unstyled) text to a visible budget, ellipsis on cut. */
export function truncateVisible(text: string, budget: number): string {
	return budget <= 0 ? "" : stripAnsi(truncateToWidth(text, budget, "…"));
}

/** Duration for the suffix: seconds with one decimal, or ms under 100. */
export function formatDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "";
	if (ms < 100) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The first meaningful line of a tool result's text output, for the error
 * suffix. Returns "" when there is no text content.
 */
export function firstTextLine(content: Array<{ type: string; text?: string }> | undefined): string {
	if (!Array.isArray(content)) return "";
	for (const block of content) {
		if (block?.type !== "text" || typeof block.text !== "string") continue;
		const match = /[^\s][^\r\n]*/.exec(block.text);
		if (match) return match[0].trim();
	}
	return "";
}

/** Status info stored in the shared per-block renderer state. */
export interface ZenInfo {
	ok: boolean;
	durationMs: number | undefined;
	errLine: string;
	warning?: string;
}

/** Extract zen's status info from a final result and its context. */
export function infoFromResult(
	result: { content: Array<{ type: string; text?: string }>; details?: any },
	ctx: { isError: boolean; durationMs?: number },
): ZenInfo {
	return {
		ok: !ctx.isError,
		durationMs: ctx.durationMs,
		errLine: ctx.isError ? truncateVisible(singleLine(firstTextLine(result.content)), 200) : "",
		warning: result.details?.truncation?.truncated || result.details?.matchLimitReached ||
			result.details?.resultLimitReached || result.details?.linesTruncated ? "truncated" :
			typeof result.details?.fullOutputPath === "string" && result.details.fullOutputPath ? "full output" : "",
	};
}

/** Whether new info differs from stored info. */
export function infoChanged(prev: ZenInfo | undefined, next: ZenInfo): boolean {
	return (
		prev === undefined || prev.ok !== next.ok || prev.durationMs !== next.durationMs || prev.errLine !== next.errLine ||
		prev.warning !== next.warning
	);
}

/**
 * The suffix appended to the call line, or "" when there is nothing to show.
 * Styled with the theme given by pi.
 */
export function suffixFor(info: ZenInfo | undefined, theme: any): string {
	if (!info) return "";
	const dur = formatDuration(info.durationMs);
	const durText = dur ? ` (${dur})` : "";
	if (info.ok) return theme.fg("muted", " ✓") +
		(info.warning ? theme.fg("warning", ` ${info.warning}`) : "") + theme.fg("muted", durText);
	return theme.fg("error", ` ✗ ${info.errLine}${durText}`);
}

// ─── per-tool call-line formatting (pure; exported for unit tests) ───────────

/** Built-in tools with short call summaries. */
export const NATIVE_ONE_LINE_TOOLS = new Set(["bash", "powershell", "read", "ls", "find", "grep"]);

/** Sanitize only the preview. Original arguments and output stay untouched. */
export function singleLine(text: string): string {
	return stripTerminalSequences(text.replace(/\u009b[0-?]*[ -/]*[@-~]/g, ""))
		.replace(/[\x00-\x1f\x7f-\x9f\uFFF9-\uFFFB]+/g, " ").trim();
}

/** A short string for an arbitrary args object, for generic one-liners. */
export function condenseArgs(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "object" && !Array.isArray(args)) {
		for (const key of ["command", "path", "file_path", "pattern", "query", "url", "description", "name"]) {
			const value = (args as Record<string, unknown>)[key];
			if (typeof value === "string" && value) return value;
		}
		const first = Object.entries(args as Record<string, unknown>)[0];
		if (first) {
			if (typeof first[1] === "string") return first[1];
			return `${first[0]}: ${Array.isArray(first[1]) ? `${first[1].length} items` :
				first[1] !== null && typeof first[1] === "object" ? "object" : String(first[1])}`;
		}
		return "";
	}
	return typeof args === "string" ? args : Array.isArray(args) ? `${args.length} items` : String(args);
}

/**
 * Zen's own compact call line for tools whose native collapsed call is
 * multi-line (write, edit) and for unknown/MCP tools.
 */
export function compactCallText(toolName: string, args: any, theme: any): string {
	const title = theme.fg("toolTitle", theme.bold(toolName));
	if (toolName === "write") {
		const filePath = args?.file_path ?? args?.path;
		const lines = typeof args?.content === "string" ? args.content.split("\n").length : undefined;
		const size = lines !== undefined ? theme.fg("muted", ` (${lines} lines)`) : "";
		return `${title} ${String(filePath ?? "")}${size}`;
	}
	if (toolName === "edit") {
		const filePath = args?.file_path ?? args?.path;
		const edits = Array.isArray(args?.edits) ? args.edits.length : args?.oldText ? 1 : 0;
		const size = theme.fg("muted", ` (${edits} edit${edits === 1 ? "" : "s"})`);
		return `${title} ${String(filePath ?? "")}${size}`;
	}
	return `${title} ${theme.fg("toolOutput", truncateVisible(condenseArgs(args), 60))}`;
}

// ─── renderer state helpers ─────────────────────────────────────────────────

const STATE_KEY = "zen";
const CALL_KEY = "zenCall";
const INFO_KEY = "zenInfo";
const RESULT_KEY = "zenResult";
const EMPTY_RESULT = { render: (_width: number): string[] => [], invalidate() {} };

/** The renderer state object pi shares between call and result renderers. */
function stateOf(ctx: any): Record<string, any> {
	const state = ctx?.state;
	return typeof state === "object" && state !== null ? state : {};
}

/** Update the existing compact row before the current paint. */
function storeFinalInfo(result: any, ctx: any, state: any): void {
	const truncated = !!(result.details?.truncation?.truncated || result.details?.matchLimitReached ||
		result.details?.resultLimitReached || result.details?.linesTruncated);
	const errorSource = ctx.isError ? result.content?.find((block: any) => block.type === "text" && block.text)?.text : undefined;
	const outputPath = result.details?.fullOutputPath;
	if (state.zenContent === result.content && state.zenError === ctx.isError &&
		state.zenDuration === ctx.durationMs && state.zenTruncated === truncated &&
		state.zenOutputPath === outputPath && state.zenErrorSource === errorSource && state[INFO_KEY]) return;
	state.zenContent = result.content;
	state.zenError = ctx.isError;
	state.zenDuration = ctx.durationMs;
	state.zenTruncated = truncated;
	state.zenErrorSource = errorSource;
	state.zenOutputPath = outputPath;
	const info = infoFromResult(result, ctx);
	if (!infoChanged(state[INFO_KEY], info)) return;
	state[INFO_KEY] = info;
	state[STATE_KEY]?.finish(info);
}

/** A shared zero-row component for collapsed results. */
function emptyResult(): typeof EMPTY_RESULT {
	return EMPTY_RESULT;
}

/** Sanitized fallback for a native renderer that throws. */
function plainTextResult(result: any, theme: any): Text {
	return new Text(theme.fg("toolOutput", genericOutput(result, false)), 0, 0);
}

/** Summary fields that matter in a collapsed row, never raw output scans. */
function previewPath(value: unknown, cwd: string): string {
	if (typeof value !== "string") return "";
	if (!path.isAbsolute(value)) return singleLine(value);
	const rel = path.relative(cwd || process.cwd(), value);
	return singleLine(rel && !rel.startsWith("../") && rel !== ".." ? rel : value);
}

/** Fit paths from the tail, keeping the filename rather than the root. */
function fitPath(value: string, width: number): string {
	if (terminalWidth(value) <= width) return value;
	if (width <= 1) return truncateVisible(value, width);
	return "…" + sliceByColumn(value, Math.max(0, terminalWidth(value) - width + 1), width - 1, true);
}

/** Values, not object identity: streaming parsers may mutate arguments. */
function previewValues(tool: string, args: any, ctx: any): unknown[] {
	return [args?.file_path ?? args?.path, args?.command, args?.offset, args?.limit,
		args?.timeout, args?.content, args?.edits?.length, args?.oldText,
		tool === "find" || tool === "grep" ? args?.pattern : undefined,
		tool === "mcp" ? args?.tool : undefined, tool === "mcp" ? args?.name : undefined,
		tool === "mcp" ? args?.search : undefined, tool === "mcp" ? args?.describe : undefined,
		tool === "mcp" ? args?.server : undefined, tool === "mcp" ? args?.action : undefined,
		NATIVE_ONE_LINE_TOOLS.has(tool) || tool === "write" || tool === "edit" || tool === "mcp" ? undefined : condenseArgs(args),
		ctx.cwd, ctx.outputPad ?? 1, ctx.isPartial, ctx.isError];
}

function previewParts(tool: string, args: any, cwd: string): { title: string; body: string; tail: string; path: boolean } {
	if (tool === "bash" || tool === "powershell") return {
		title: tool === "bash" ? "$" : "PS>", body: singleLine(String(args?.command ?? "…")),
		tail: args?.timeout ? ` (timeout ${args.timeout}s)` : "", path: false,
	};
	if (["read", "write", "edit", "ls"].includes(tool)) {
		let tail = "";
		if (tool === "read" && (args?.offset || args?.limit)) {
			const start = args.offset ?? 1;
			tail = args.limit ? `:${start}–${start + args.limit - 1}` : `:${start}…`;
		}
		if (tool === "write" && typeof args?.content === "string") {
			let count = 1;
			for (let i = args.content.indexOf("\n"); i !== -1; i = args.content.indexOf("\n", i + 1)) count++;
			tail = ` (${count} lines)`;
		}
		if (tool === "edit") {
			const count = Array.isArray(args?.edits) ? args.edits.length : args?.oldText ? 1 : 0;
			tail = ` (${count} edit${count === 1 ? "" : "s"})`;
		}
		return { title: tool, body: previewPath(args?.file_path ?? args?.path, cwd), tail, path: true };
	}
	if (tool === "find" || tool === "grep") return {
		title: tool, body: singleLine(String(args?.pattern ?? "")) +
			(args?.path ? ` in ${previewPath(args.path, cwd)}` : ""), tail: "", path: false,
	};
	if (tool === "mcp") {
		const operation = args?.tool ?? args?.name ?? (args?.describe ? `describe ${args.describe}` :
			args?.search ? `search ${args.search}` : args?.action ?? args?.server ?? "status");
		return { title: "mcp", body: singleLine(String(operation)), tail: "", path: false };
	}
	return { title: tool, body: singleLine(condenseArgs(args)), tail: "", path: false };
}

/** One physical row, cached across unchanged invalidation passes. */
function compactRow(tool: string): any {
	return {
		values: undefined as unknown[] | undefined, colors: undefined as any, info: undefined as ZenInfo | undefined,
		parts: undefined as ReturnType<typeof previewParts> | undefined, theme: undefined as any,
		width: -1, lines: [] as string[], pad: 1, bg: "toolPendingBg",
		update(args: any, theme: any, ctx: any, state: any) {
			const values = previewValues(tool, args, ctx);
			const changed = !this.values || values.some((v, i) => v !== this.values[i]);
			if (changed) this.parts = previewParts(tool, args, ctx.cwd);
			if (changed || this.colors !== theme.colors || this.info !== state[INFO_KEY] || this.theme !== theme) {
				this.width = -1;
				this.values = values;
				this.colors = theme.colors;
				this.info = state[INFO_KEY];
				this.theme = theme;
				this.pad = ctx.outputPad ?? 1;
				this.bg = ctx.isPartial ? "toolPendingBg" : ctx.isError ? "toolErrorBg" : "toolSuccessBg";
			}
		},
		finish(info: ZenInfo) {
			this.info = info;
			this.bg = info.ok ? "toolSuccessBg" : "toolErrorBg";
			this.width = -1;
		},
		render(width: number): string[] {
			if (this.width === width) return this.lines;
			const pad = Math.min(this.pad, Math.max(0, Math.floor((width - 1) / 2)));
			const budget = Math.max(0, width - 2 * pad);
			const { parts, info, theme } = this;
			let status = suffixFor(info, theme);
			const titleWidth = Math.min(terminalWidth(parts.title) + 1, Math.max(0, Math.floor(budget / 3)));
			// Errors and structured warnings outrank elapsed time on narrow panes.
			if (info && terminalWidth(status) > budget - titleWidth) {
				const available = Math.max(0, budget - titleWidth);
				const text = info.ok ? ` ✓${info.warning ? ` ${info.warning}` : ""}` : ` ✗ ${info.errLine}`;
				status = theme.fg(info.ok ? info.warning ? "warning" : "muted" : "error", truncateVisible(text, available));
			}
			const callBudget = Math.max(0, budget - terminalWidth(status));
			const title = truncateVisible(parts.title, callBudget);
			const rest = Math.max(0, callBudget - terminalWidth(title) - 1);
			const tail = truncateVisible(parts.tail, rest);
			const bodyBudget = Math.max(0, rest - terminalWidth(tail));
			const body = parts.path ? fitPath(parts.body, bodyBudget) : truncateVisible(parts.body, bodyBudget);
			const call = theme.fg("toolTitle", theme.bold(title)) +
				(rest > 0 ? " " + theme.fg("toolOutput", body) + theme.fg("muted", tail) : "");
			const line = " ".repeat(pad) + call + status;
			this.lines = [theme.bg(this.bg, line + " ".repeat(Math.max(0, width - terminalWidth(line))))];
			this.width = width;
			return this.lines;
		},
		invalidate() { /* update compares values and colors; a new width misses the cache */ },
	};
}

/** Avoid re-flattening unchanged native detail rows on every cached paint. */
class DetailFrame extends Box {
	private paintedWidth = -1;
	private paintedLines: string[] | undefined;
	private cacheAllowed = false;
	invalidateCache(): void {
		super.invalidateCache();
		this.paintedLines = undefined;
	}
	handleMouse(event: any): any {
		this.paintedLines = undefined;
		return super.handleMouse(event);
	}
	setCacheAllowed(allowed: boolean): void { this.cacheAllowed = allowed; }
	render(width: number): string[] {
		if (this.cacheAllowed && this.paintedLines && this.paintedWidth === width) return this.paintedLines;
		this.paintedWidth = width;
		return this.paintedLines = super.render(width);
	}
}

/** Native framing through public Box, never private Pi components. */
function nativeFrame(call: any, theme: any, ctx: any, state: any): any {
	const pad = ctx.outputPad ?? 1;
	if (!state.zenFrame || state.zenFramePad !== pad) {
		state.zenFrame = new DetailFrame(pad, 1);
		state.zenFramePad = pad;
	}
	state.zenFrameExpanded = ctx.expanded;
	const box = state.zenFrame;
	box.setCacheAllowed(state.zenCacheDetail === true);
	box.setBgFn((line: string) => theme.bg(ctx.isPartial ? "toolPendingBg" : ctx.isError ? "toolErrorBg" : "toolSuccessBg", line));
	box.clear();
	box.addChild(call);
	return box;
}

/** Call a native renderer, returning undefined when it throws (fail-open). */
function safeNative(fn: any, ...args: unknown[]): any {
	try {
		return fn?.(...args);
	} catch {
		return undefined;
	}
}

// ─── invalidate registry (toggle refresh, public API only) ───────────────────

/**
 * Per-block invalidate closures, keyed by the block's renderer state
 * object (stable across passes, unique per block). On toggle, zen calls
 * them all so every existing block re-renders with the new mode. Cleared
 * on lifecycle events that rebuild all blocks.
 */
const registry = new Map<object, () => void>();

function rememberInvalidate(ctx: any): void {
	const state = ctx?.state;
	if (typeof state === "object" && state !== null && typeof ctx.invalidate === "function") {
		registry.set(state, ctx.invalidate);
	}
}

function refreshAllBlocks(): void {
	for (const invalidate of registry.values()) {
		try {
			invalidate();
		} catch {
			/* one dead block never blocks the rest */
		}
	}
}

function clearRegistry(): void {
	registry.clear();
}

/** Test seam: the number of live per-block invalidate closures. */
export function __registrySizeForTest(): number {
	return registry.size;
}

// ─── wrappers ─────────────────────────────────────────────────────────────────

/** Whether this block renders compact right now. */
const isCompact = (ctx: any) => filterOn && !(ctx?.expanded === true);

/** Whether a result render is compact: expanded arrives via options here. */
const isCompactResult = (options: { expanded?: boolean }) => filterOn && !(options?.expanded === true);

/** Wrap a tool's native renderers with zen's compact behavior. */
function wrapNative(toolName: string, native: { renderCall?: any; renderResult?: any; renderShell?: string }): any {
	const self = native.renderShell === "self";
	// A native renderer may keep its own timer after expansion. Let its final
	// pass stop that timer, but do not repaint hidden native details meanwhile.
	const nativeContext = (ctx: any, state: any, lastComponent: any) => ({
		...ctx, lastComponent,
		invalidate: () => { if (state.zenNativeVisible) ctx.invalidate?.(); },
	});
	const nativeResult = (result: any, options: any, theme: any, ctx: any, state: any) => {
		const component = safeNative(native.renderResult, result, options, theme,
			nativeContext(ctx, state, state[RESULT_KEY])) ?? (native.renderResult ? plainTextResult(result, theme) : fallbackResult(result, options, theme, ctx, state));
		state[RESULT_KEY] = component;
		return component;
	};
	return {
		...native,
		renderShell: "self",
		renderCall(args: any, theme: any, ctx: any) {
			rememberInvalidate(ctx);
			const state = stateOf(ctx);
			state.zenNativeVisible = !isCompact(ctx);
			if (state.zenNativeVisible) {
				if (ctx.isPartial) state.zenPartialResult = true;
				const call = safeNative(native.renderCall, args, theme, nativeContext(ctx, state, state[CALL_KEY])) ??
					new Text(registeredCallText(toolName, args, theme, ctx.expanded), 0, 0);
				state[CALL_KEY] = call;
				state.zenCacheDetail = NATIVE_ONE_LINE_TOOLS.has(toolName) || toolName === "write" || toolName === "edit";
				return self ? call : nativeFrame(call, theme, ctx, state);
			}
			const row = state[STATE_KEY] ??= compactRow(toolName);
			row.update(args, theme, ctx, state);
			return row;
		},
		renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, ctx: any) {
			const state = stateOf(ctx);
			if (!isCompactResult(options)) {
				state.zenNativeVisible = true;
				// Off or expanded: native result rendering.
				// A throw falls back to plain text (fail-open), never
				// undefined: pi's updateDisplay would addChild(undefined).
				state.zenPartialResult = options.isPartial;
				const component = nativeResult(result, options, theme, ctx, state);
				if (self || !state.zenFrame || state.zenFrameExpanded !== ctx.expanded) return component;
				state.zenFrame?.addChild(component);
				return emptyResult();
			}
			state.zenNativeVisible = false;
			if (options.isPartial) return emptyResult();
			if (state.zenPartialResult) {
				// Let the native final pass release resources started by a partial
				// render. Keep its result slot separate from our empty component.
				nativeResult(result, options, theme, ctx, state);
				state.zenPartialResult = false;
			}
			// The call component is already in Pi's container. Update it now,
			// so status and background land together without another repaint.
			storeFinalInfo(result, ctx, state);
			return emptyResult();
		},
	};
}

/** Match native fallback output sanitization and image labels. */
function genericOutput(result: any, showImages: boolean): string {
	const content = result.content ?? [];
	let output = content.filter((c: any) => c.type === "text")
		.map((c: any) => stripTerminalSequences((c.text || "").replace(/\u009b[0-?]*[ -/]*[@-~]/g, "")).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "").replace(/\r/g, ""))
		.join("\n");
	if (!getCapabilities().images || !showImages) {
		for (const block of content) {
			if (block.type !== "image") continue;
			const dims = block.data && block.mimeType ? getImageDimensions(block.data, block.mimeType) : undefined;
			const fallback = imageFallback(block.mimeType ?? "image/unknown", dims ?? undefined);
			output += (output ? "\n" : "") + fallback;
		}
	}
	return output;
}

function registeredCallText(toolName: string, args: any, theme: any, expanded: boolean): string {
	const header = theme.fg("toolTitle", theme.bold(toolName));
	if (args == null) return header;
	const entries = typeof args === "object" && !Array.isArray(args) ? Object.entries(args) : [["args", args]];
	if (!entries.length) return header;
	if (expanded) {
		const lines = entries.map(([key, value]) => {
			const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
			return `  ${key}: ${text.replace(/\t/g, "   ").replace(/\r/g, "").split("\n").join("\n    ")}`;
		});
		return `${header}\n${theme.fg("muted", lines.join("\n"))}`;
	}
	const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
	return `${header} ${theme.fg("muted", pairs.length > 100 ? pairs.slice(0, 97) + "..." : pairs)}`;
}

/** Match Pi's fallback when a custom definition lacks a result renderer. */
function fallbackResult(result: any, options: any, theme: any, ctx: any, state: any): any {
	const output = genericOutput(result, ctx.showImages);
	const lines = output ? output.split("\n") : [];
	const shown = options.expanded ? lines : lines.slice(0, 10);
	let body = shown.map((line: string) => theme.fg("toolOutput", line)).join("\n");
	const remaining = lines.length - shown.length;
	if (remaining > 0) {
		const keys = getKeybindings().getKeys("app.tools.expand").join("/")
			.replace(/alt/g, process.platform === "darwin" ? "option" : "alt");
		body += theme.fg("muted", `\n... (${remaining} more lines,`) + " " +
			theme.fg("dim", keys) + theme.fg("muted", " to expand") + theme.fg("muted", ")");
	}
	const text = state.zenFallbackResult ??= new Text("", 0, 0);
	text.setText(body);
	return text;
}

/** Registered tools use native fallback slots; unknown tools use one Text. */
function genericRenderers(toolName: string, registered: boolean, self = false): any {
	const background = (theme: any, ctx: any) => (line: string) =>
		theme.bg(ctx.isPartial ? "toolPendingBg" : ctx.isError ? "toolErrorBg" : "toolSuccessBg", line);
	return {
		renderShell: "self",
		renderCall(args: any, theme: any, ctx: any) {
			rememberInvalidate(ctx);
			const state = stateOf(ctx);
			if (isCompact(ctx)) {
				const row = state[STATE_KEY] ??= compactRow(toolName);
				row.update(args, theme, ctx, state);
				return row;
			}
			const text = state[CALL_KEY] ??= new Text("", registered ? 0 : ctx.outputPad ?? 1, registered ? 0 : 1);
			if (!registered) {
				text.setPaddingX(ctx.outputPad ?? 1);
				text.setCustomBgFn(background(theme, ctx));
			}
			if (registered) {
				text.setText(registeredCallText(toolName, args, theme, ctx.expanded));
				state.zenCacheDetail = true;
				return self ? text : nativeFrame(text, theme, ctx, state);
			}
			// Unknown native fallback keeps arguments and output in one Text.
			const argsText = JSON.stringify(args, null, 2);
			state.zenGenericHeader = theme.fg("toolTitle", theme.bold(toolName)) +
				(argsText ? `\n\n${argsText}` : "");
			text.setText(state.zenGenericHeader);
			return text;
		},
		renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, ctx: any) {
			const state = stateOf(ctx);
			if (!isCompactResult(options)) {
				if (registered) {
					const text = fallbackResult(result, options, theme, ctx, state);
					if (self || !state.zenFrame || state.zenFrameExpanded !== ctx.expanded) return text;
					state.zenFrame?.addChild(text);
					return emptyResult();
				}
				const output = genericOutput(result, ctx.showImages);
				// renderCall and renderResult share state. Updating the call Text
				// here avoids a second wrapping pass and a deferred repaint.
				const text = state[CALL_KEY] ??= new Text("", ctx.outputPad ?? 1, 1);
				text.setCustomBgFn(background(theme, ctx));
				text.setText((state.zenGenericHeader ?? "") + (output ? `\n${output}` : ""));
				return emptyResult();
			}
			if (options.isPartial) return emptyResult();
			storeFinalInfo(result, ctx, state);
			return emptyResult();
		},
	};
}

/**
 * The resolver zen registers. Exported for unit tests with an injectable
 * filter getter (the live one reads the module toggle).
 */
export function makeResolver(getFilter: () => boolean): (toolName: string, next: () => any) => any {
	return (toolName: string, next: () => any) => {
		const native = next();
		if (!getFilter()) {
			// Off: byte-exact native for new blocks.
			return native;
		}
		if (native && typeof (native as any).renderCall === "function") {
			return wrapNative(toolName, native);
		}
		if (native && typeof (native as any).renderResult === "function" && !(native as any).renderCall) {
			// Definition with a result renderer only: wrap what exists.
			return wrapNative(toolName, native);
		}
		return genericRenderers(toolName, native !== undefined, native?.renderShell === "self");
	};
}

// ─── module state (single-session-per-process) ──────────────────────────────

let filterOn = true;

// ─── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-zen", {
		description: "Start with the compact transcript off, regardless of the saved default",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("zen", {
		description: "Start with the compact transcript on, regardless of the saved default",
		type: "boolean",
		default: false,
	});

	const toggle = (on: boolean, ctx: ExtensionContext): void => {
		filterOn = on;
		const saved = saveFilterOn(on);
		refreshAllBlocks();
		ctx.ui.notify(
			`zen: ${on ? "on" : "off"}` +
				(on ? " (one-line tool calls; click or ctrl+o expands)" : " (full native transcript)") +
				(saved ? "" : " — could not save, session only"),
			"info",
		);
	};

	pi.registerCommand("zen", {
		description: "Toggle compact tool calls: one line per call with status; expand for full detail",
		handler: async (args, ctx) => {
			const arg = String(args ?? "").trim().toLowerCase();
			const next = arg === "on" ? true : arg === "off" ? false : !filterOn;
			if (next === filterOn) {
				ctx.ui.notify(`zen: already ${filterOn ? "on" : "off"}`, "info");
				return;
			}
			toggle(next, ctx);
		},
	});

	pi.registerShortcut("ctrl+alt+t", {
		description: "Toggle compact tool calls (zen)",
		handler: async (ctx) => {
			toggle(!filterOn, ctx);
		},
	});

	pi.registerToolRenderer(makeResolver(() => filterOn));

	pi.on("session_start", (_e, _ctx) => {
		// Explicit flags win over the saved default; neither persists it.
		filterOn = pi.getFlag("zen") ? true : pi.getFlag("no-zen") ? false : loadFilterOn();
		clearRegistry();
	});

	// Container rebuilds: fresh components resolve renderers again, and
	// the registry must not keep closures of dead blocks.
	pi.on("session_tree", () => clearRegistry());
	pi.on("compaction", () => clearRegistry());
}
