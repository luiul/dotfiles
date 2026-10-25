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
 * Every tool call stays visible as exactly one line: the native call line
 * plus a status suffix. Success blocks show `✓ (0.4s)`; failed blocks
 * show `✗ <first error line> (2.1s)` on the native error background.
 * Click or ctrl+o expands any block to pi's full native rendering
 * (byte-exact, pure delegation); clicking again collapses it back.
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
 * - Status colors stay native: pending, success, and error backgrounds
 *   come from ToolExecutionComponent, untouched.
 * - Thinking is fully native: the `hideThinkingBlock` setting collapses
 *   it, ctrl+t peeks at one message. Zen v1's thinking code is gone.
 *
 * The one-line status suffix: the call and result renderers share the
 * per-block `context.state` object (the same mechanism pi's bash timer
 * uses). renderResult stores {ok, durationMs, errLine} there once a
 * final result arrives and schedules ONE deferred invalidate
 * (setTimeout 0, avoiding synchronous re-entry into updateDisplay);
 * the extra pass lets renderCall append the suffix to the call line.
 * Writes happen only on change, so the sequence terminates in two
 * passes (unit-tested).
 *
 * Per-tool call lines:
 * - One-line native calls (bash, read, ls, find, grep, powershell) keep
 *   pi's own formatting: zen delegates, then appends the suffix at
 *   render time through a tiny decorator component. Native niceties
 *   (path shortening, $ prompt, bash timer state) keep working.
 * - Multi-line native calls (write, edit) get zen's own compact line
 *   (`write <path> (N lines)`, `edit <path> (N edits)`) while collapsed;
 *   expanded delegates to native.
 * - Unknown and MCP tools (no renderer functions) get a generic one-line
 *   renderer: bold tool name plus condensed args, full output expanded.
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
 * Overhead: the wrappers run once per updateDisplay pass (per tool event)
 * and do strictly less work than the native previews when collapsed (no
 * output styling, no VisualLinePreview, no highlight-cache rebuild). The
 * decorator adds one function call per painted line. Baselines and
 * targets: luiul/dotfiles#67 (bench harness: scripts/bench-zen-*.ts/sh).
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
import { Container, Text } from "@earendil-works/pi-tui";
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

/** Visible length of styled text. Counts code points, ANSI stripped. */
export function visibleWidth(text: string): number {
	return [...stripAnsi(text)].length;
}

/** Truncate plain (unstyled) text to a visible budget, ellipsis on cut. */
export function truncateVisible(text: string, budget: number): string {
	const chars = [...text];
	if (chars.length <= budget) return text;
	const cut = budget <= 1 ? 0 : budget - 1;
	return chars.slice(0, cut).join("") + "…";
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
		for (const line of block.text.split("\n")) {
			const trimmed = line.trim();
			if (trimmed) return trimmed;
		}
	}
	return "";
}

/** Status info stored in the shared per-block renderer state. */
export interface ZenInfo {
	ok: boolean;
	durationMs: number | undefined;
	errLine: string;
}

/** Extract zen's status info from a final result and its context. */
export function infoFromResult(
	result: { content: Array<{ type: string; text?: string }> },
	ctx: { isError: boolean; durationMs?: number },
): ZenInfo {
	return {
		ok: !ctx.isError,
		durationMs: ctx.durationMs,
		errLine: ctx.isError ? truncateVisible(firstTextLine(result.content), 50) : "",
	};
}

/** Whether new info differs from stored info (drives the deferred invalidate). */
export function infoChanged(prev: ZenInfo | undefined, next: ZenInfo): boolean {
	return (
		prev === undefined || prev.ok !== next.ok || prev.durationMs !== next.durationMs || prev.errLine !== next.errLine
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
	if (info.ok) return theme.fg("muted", ` ✓${durText}`);
	return theme.fg("error", ` ✗ ${info.errLine}${durText}`);
}

// ─── per-tool call-line formatting (pure; exported for unit tests) ───────────

/** Tools whose native collapsed call line is already one line: delegate. */
export const NATIVE_ONE_LINE_TOOLS = new Set(["bash", "powershell", "read", "ls", "find", "grep"]);

/** A short string for an arbitrary args object, for generic one-liners. */
export function condenseArgs(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "object" && !Array.isArray(args)) {
		for (const key of ["command", "path", "file_path", "pattern", "query", "url", "description", "name"]) {
			const value = (args as Record<string, unknown>)[key];
			if (typeof value === "string" && value) return value;
		}
		const first = Object.entries(args as Record<string, unknown>)[0];
		if (first && typeof first[1] === "string") return first[1];
	}
	const text = typeof args === "string" ? args : JSON.stringify(args);
	return truncateVisible(text ?? "", 60);
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

/** The renderer state object pi shares between call and result renderers. */
function stateOf(ctx: any): Record<string, any> {
	const state = ctx?.state;
	return typeof state === "object" && state !== null ? state : {};
}

/** A zero-row component for collapsed results. */
function emptyResult(): Container {
	return new Container();
}

/** Plain text result output, the fail-open fallback for native throws. */
function plainTextResult(result: any, theme: any): Container {
	const container = new Container();
	const output = result?.content
		?.filter((c: any) => c.type === "text")
		.map((c: any) => c.text || "")
		.join("\n");
	if (output) container.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
	return container;
}

/**
 * Decorator component: native call rendering with the status suffix
 * appended to the first painted line. handleMouse delegates to the
 * wrapped component so native click regions keep working.
 */
function decoratedCall(comp: any, suffixFn: () => string): any {
	return {
		render(width: number): string[] {
			const suffix = suffixFn();
			if (!suffix) return comp.render(width);
			// Render the native line narrower so the suffix fits inside the
			// width pi asked for: native renderers pad their lines to the
			// width given, so appending after a full-width render would push
			// the suffix past the visible edge (measured: clipped by the
			// pane before this fix).
			const budget = Math.max(1, width - visibleWidth(suffix));
			const lines = comp.render(budget);
			if (lines.length === 0) return lines;
			return [lines[0] + suffix, ...lines.slice(1)];
		},
		invalidate(): void {
			// pi-tui requires invalidate on every component (MouseRegion
			// and theme changes call it).
			try {
				comp.invalidate?.();
			} catch {
				/* fail-open */
			}
		},
		handleMouse(event: any) {
			return comp.handleMouse?.(event);
		},
	};
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
function wrapNative(toolName: string, native: { renderCall?: any; renderResult?: any }): any {
	return {
		renderCall(args: any, theme: any, ctx: any) {
			rememberInvalidate(ctx);
			const state = stateOf(ctx);
			const oneLine = NATIVE_ONE_LINE_TOOLS.has(toolName);
			if (!isCompact(ctx) && oneLine) {
				// Off or expanded: plain native call line. Native throws fall
				// back to a minimal title line (fail-open), never undefined:
				// pi's updateDisplay would addChild(undefined).
				const comp = safeNative(native.renderCall, args, theme, {
					...ctx,
					lastComponent: state[CALL_KEY],
				});
				if (comp) {
					state[CALL_KEY] = comp;
					return comp;
				}
				return (
					safeNative(native.renderCall, args, theme, ctx) ??
					new Text(theme.fg("toolTitle", theme.bold(toolName)), 0, 0)
				);
			}
			if (!isCompact(ctx) && !oneLine) {
				// Off or expanded: full native call (diffs, content).
				return safeNative(native.renderCall, args, theme, ctx) ?? new Text("", 0, 0);
			}
			if (oneLine) {
				// Compact: native call line + suffix via the decorator. The
				// native component is kept and fed back as lastComponent so
				// its internal reuse (bash timer, path handling) works. A
				// throw falls back to a minimal title line (fail-open).
				const comp =
					safeNative(native.renderCall, args, theme, { ...ctx, lastComponent: state[CALL_KEY] }) ??
					new Text(theme.fg("toolTitle", theme.bold(toolName)), 0, 0);
				state[CALL_KEY] = comp;
				return decoratedCall(comp, () => suffixFor(state[INFO_KEY], theme));
			}
			// Compact, multi-line native call (write, edit): zen's own line.
			state[CALL_KEY] ??= new Text("", 0, 0);
			const text = state[CALL_KEY];
			text.setText(compactCallText(toolName, args, theme) + suffixFor(state[INFO_KEY], theme));
			return text;
		},
		renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, ctx: any) {
			rememberInvalidate(ctx);
			const state = stateOf(ctx);
			if (!isCompactResult(options) || options.isPartial) {
				// Off, expanded, or still running: native result rendering.
				// A throw falls back to plain text (fail-open), never
				// undefined: pi's updateDisplay would addChild(undefined).
				return (
					safeNative(native.renderResult, result, options, theme, ctx) ??
					plainTextResult(result, theme)
				);
			}
			// Compact, final result: one line. Success shows nothing below
			// the call line; failure puts its first line on the call line
			// via the suffix. Store the info, then ONE deferred invalidate
			// lets renderCall repaint with the suffix (no synchronous
			// re-entry into updateDisplay; terminates because the second
			// pass stores identical info).
			const info = infoFromResult(result, ctx);
			if (infoChanged(state[INFO_KEY], info)) {
				state[INFO_KEY] = info;
				setTimeout(() => {
					try {
						ctx.invalidate?.();
					} catch {
						/* block may be gone */
					}
				}, 0);
			}
			return emptyResult();
		},
	};
}

/**
 * Generic renderers for tools without native renderer functions (MCP tools,
 * not-yet-connected servers, unknown tools): bold name plus condensed args,
 * one line; full text output when expanded.
 */
function genericRenderers(toolName: string): any {
	return {
		renderCall(args: any, theme: any, ctx: any) {
			rememberInvalidate(ctx);
			const state = stateOf(ctx);
			if (!isCompact(ctx)) {
				// Expanded: the full argument dump like pi's fallback.
				state[CALL_KEY] ??= new Text("", 0, 0);
				const text = state[CALL_KEY];
				text.setText(theme.fg("toolTitle", theme.bold(toolName)) + "\n" + (JSON.stringify(args, null, 2) ?? ""));
				return text;
			}
			state[CALL_KEY] ??= new Text("", 0, 0);
			const text = state[CALL_KEY];
			text.setText(compactCallText(toolName, args, theme) + suffixFor(state[INFO_KEY], theme));
			return text;
		},
		renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, ctx: any) {
			rememberInvalidate(ctx);
			const state = stateOf(ctx);
			if (!isCompactResult(options)) {
				const output = result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text || "")
					.join("\n");
				if (!output) return emptyResult();
				return new Text(theme.fg("toolOutput", output), 0, 0);
			}
			if (options.isPartial) return emptyResult();
			const info = infoFromResult(result, ctx);
			if (infoChanged(state[INFO_KEY], info)) {
				state[INFO_KEY] = info;
				setTimeout(() => {
					try {
						ctx.invalidate?.();
					} catch {
						/* block may be gone */
					}
				}, 0);
			}
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
		return genericRenderers(toolName);
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
