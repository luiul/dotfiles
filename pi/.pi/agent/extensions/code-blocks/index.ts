/**
 * Compact reply code frames, adapted from pi-markdown-blocks (MIT).
 * https://github.com/FasalZein/pi-markdown-blocks/tree/2403950d2916c67559f108f3cc11770123d4bb59
 * See LICENSE. No added dependencies, timers, workers, or second Markdown parser.
 * The private code-token hook is isolated and restricted to the verified Pi version.
 */
import { VERSION, copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, Marked, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type MarkdownTheme } from "@earendil-works/pi-tui";

const STATE = Symbol.for("dotfiles.reply-code-blocks.v1");
const RESET_BG = "\x1b[49m";
const GUIDANCE = "In replies, use top-level Mermaid fences for useful diagrams, short labels, and vertical layouts. Use a language-only code fence; put filenames outside it. Keep saved documentation diagram conventions unchanged.";
type Token = { type: string; text: string; lang?: string; codeBlockStyle?: string };
type Runtime = { theme: MarkdownTheme; blockHighlightedCode?: Map<string, string[]> };
type RenderToken = (this: Runtime, token: Token, width: number, next?: string, style?: unknown) => string[];
type Render = (this: Markdown, width: number) => string[];
type Patch = { original: RenderToken; render: Render; patched: RenderToken; wrapped: Render; active: boolean; scopes: boolean[] };
type Prototype = { renderToken: RenderToken; render: Render; [STATE]?: Patch };

/** Strip source control codes before adding trusted syntax colors. Copy keeps original source. */
function displayText(text: string): string {
	return /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text) ? stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ") : text;
}

function header(theme: MarkdownTheme, label: string, width: number): string {
	const shown = truncateToWidth(label, Math.max(1, width - 6), "…");
	return theme.codeBlockBorder("╭─ ") + theme.bold(shown) + theme.codeBlockBorder(" " + "─".repeat(Math.max(0, width - 5 - visibleWidth(shown))) + "╮");
}

/** Native block-owned highlighting cache survives streaming and width changes. */
function frame(owner: Runtime, token: Token, width: number, next: string | undefined): string[] {
	const theme = owner.theme;
	const label = displayText(token.lang ?? "").trim().split(/\s+/, 1)[0] || "text";
	const key = `${label}\0${token.text}`;
	let highlighted = owner.blockHighlightedCode?.get(key);
	if (!highlighted) {
		const source = displayText(token.text);
		highlighted = theme.highlightCode ? theme.highlightCode(source, label) : source.split("\n").map(line => theme.codeBlock(line));
		owner.blockHighlightedCode?.set(key, highlighted);
	}
	const padding = width >= 6 ? 1 : 0;
	const innerWidth = width - 2 - padding * 2;
	const pad = " ".repeat(padding);
	const left = theme.codeBlockBorder("│");
	const right = left;
	const output = [header(theme, label, width)];
	for (const line of highlighted) {
		const lineWidth = visibleWidth(line);
		const parts = lineWidth <= innerWidth ? [line] : wrapTextWithAnsi(line, innerWidth);
		for (const part of parts) {
			const partWidth = parts.length === 1 ? lineWidth : visibleWidth(part);
			output.push(`${left}${RESET_BG}${pad}${part}${" ".repeat(Math.max(0, innerWidth - partWidth))}${pad}${right}`);
		}
	}
	output.push(theme.codeBlockBorder(`╰${"─".repeat(width - 2)}╯`));
	if (next && next !== "space") output.push("");
	return output;
}

/** Exported for tests and benchmarks, not a second renderer. */
export function installCodeFrames(version = VERSION): { patch?: Patch; reason?: string; dispose(): void } {
	const prototype = Markdown.prototype as unknown as Prototype;
	if (version !== "1.5.1") return { reason: `Pi ${version} is not verified for code frames`, dispose() {} };
	if (prototype[STATE]) return { reason: "Another code-frame instance is active", dispose() {} };
	if (typeof prototype.renderToken !== "function" || typeof prototype.render !== "function") {
		return { reason: "The native Markdown hook changed", dispose() {} };
	}
	const original = prototype.renderToken;
	const render = prototype.render;
	const patch: Patch = { original, render, active: true, scopes: [], patched: original, wrapped: render };
	patch.wrapped = function (width) {
		patch.scopes.push(false);
		try { return render.call(this, width); }
		finally { patch.scopes.pop(); }
	};
	patch.patched = function (token, width, next, style) {
		if (!patch.active || !patch.scopes.at(-1) || token?.type !== "code" || token.codeBlockStyle === "indented" || typeof token.text !== "string" || width < 6) {
			return original.call(this, token, width, next, style);
		}
		try { return frame(this, token, width, next); }
		catch { return original.call(this, token, width, next, style); }
	};
	prototype.render = patch.wrapped;
	prototype.renderToken = patch.patched;
	prototype[STATE] = patch;
	return {
		patch,
		dispose() {
			patch.active = false;
			if (prototype.renderToken === patch.patched) prototype.renderToken = original;
			if (prototype.render === patch.wrapped) prototype.render = render;
			if (prototype[STATE] === patch) delete prototype[STATE];
		},
	};
}

/** Public display hook sets scope without parsing or changing the original reply. */
export function replyScope(patch: Patch, markdown: string): string {
	if (patch.scopes.length) patch.scopes[patch.scopes.length - 1] = true;
	return markdown;
}

export function extractCodeBlocks(text: string): { language: string; content: string }[] {
	const parser = new Marked();
	const blocks: { language: string; content: string }[] = [];
	parser.walkTokens(parser.lexer(text), token => {
		if (token.type === "code" && token.codeBlockStyle !== "indented") {
			blocks.push({ language: token.lang?.trim().split(/\s+/, 1)[0] || "text", content: token.text });
		}
	});
	return blocks;
}

function latestReply(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "assistant") {
			return entry.message.content.filter(part => part.type === "text").map(part => part.text).join("\n\n");
		}
	}
	return "";
}

export default function codeBlocks(pi: ExtensionAPI): void {
	let installed: ReturnType<typeof installCodeFrames> | undefined;
	pi.registerMarkdownTransformer(markdown => installed?.patch ? replyScope(installed.patch, markdown) : markdown, { messageTypes: ["assistant"] });
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		installed = installCodeFrames();
		if (!installed.patch) ctx.ui.notify(`Code frames disabled: ${installed.reason}`, "warning");
	});
	pi.on("session_shutdown", () => { installed?.dispose(); installed = undefined; });
	pi.on("before_agent_start", event => { event.systemPromptOptions.promptGuidelines.push(GUIDANCE); });
	pi.registerCommand("copyblock", {
		description: "Copy original code from the latest reply: /copyblock [number]",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const input = args.trim();
			if (input && (!/^[1-9]\d*$/.test(input) || !Number.isSafeInteger(Number(input)))) {
				ctx.ui.notify("Use /copyblock followed by a positive block number", "error");
				return;
			}
			const blocks = extractCodeBlocks(latestReply(ctx));
			const block = blocks[Number(input || "1") - 1];
			if (!block) { ctx.ui.notify(`Latest reply has ${blocks.length} code blocks`, "error"); return; }
			try { await copyToClipboard(block.content); ctx.ui.notify(`Copied ${block.language} source without screen wrapping`); }
			catch (error) { ctx.ui.notify(`Could not copy code: ${String(error)}`, "error"); }
		},
	});
}
