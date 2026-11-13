/** Reported closing safety for this Pi TUI session. No tools, polling, or model calls. */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

export const CLOSE_STATUS_KEY = "close-status";
const ENTRY_TYPE = "dotfiles.close-status";
const MAX_VALUE = 240;
// This stable section adds no per-run state and does not replace the cached system prompt.
export const CLOSE_GUIDANCE = `End each final reply with a blank line followed by these three plain lines, in this order, outside quotes or code fences:
safe_to_close: yes|no|unknown
close_reason: <one short line>
next_action: <one short line, or none>
Choose one lowercase value, not the alternatives. Each reason/action is at most 240 characters. Report yes only when no forgotten session-owned work or unresolved decision remains. Pending answers, approval, publication, requested checks/deployment, or owned background work mean no. Published work is not done if the required live main checkout has not been synced to the published commit. When required sync is pending, report no unless the user explicitly defers it or requests remote-only publication. Explicit preserved deferrals/handoffs may mean yes. Verify relevant evidence first; unrelated changes do not block closure. Unknown means evidence is missing. This report never authorizes publication, deployment, or worktree removal.`;

export interface CloseReport {
	safe_to_close: "yes" | "no" | "unknown";
	close_reason: string;
	next_action: string;
}
interface SavedReport {
	version: 2;
	report?: CloseReport;
	sourceId?: string;
	provider?: string;
	model?: string;
	at: number;
}
const terminal = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.hasUI;
const cleanValue = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_VALUE && value.trim() === value && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);

/** Exact suffix only. Markdown examples are not reports, even with an unclosed fence. */
export function parseCloseReport(text: string): CloseReport | undefined {
	const lines = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
	if (lines.length < 3 || lines.length > 3 && lines.at(-4)?.trim() !== "") return;
	const suffix = lines.slice(-3);
	const match = /^safe_to_close: (yes|no|unknown)$/.exec(suffix[0]);
	if (!match || !suffix[1].startsWith("close_reason: ") || !suffix[2].startsWith("next_action: ")) return;
	const reason = suffix[1].slice(14), action = suffix[2].slice(13);
	if (!cleanValue(reason) || !cleanValue(action)) return;
	let fence: { char: string; length: number } | undefined;
	for (const line of lines.slice(0, -3)) {
		// Duplicate plain fields make the report ambiguous. Quoted/fenced examples stay examples.
		if (!fence && /^(?:safe_to_close|close_reason|next_action):/.test(line)) return;
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (!marker) continue;
		if (!fence) fence = { char: marker[1][0], length: marker[1].length };
		else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
	}
	if (fence) return;
	return { safe_to_close: match[1] as CloseReport["safe_to_close"], close_reason: reason, next_action: action };
}
const cleanSource = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, "");
const replyText = (message: AssistantMessage) => message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
const sameReply = (a: AssistantMessage, b: AssistantMessage) => a.timestamp === b.timestamp && a.provider === b.provider && a.model === b.model && a.stopReason === b.stopReason && replyText(a) === replyText(b);
const validReply = (message: AssistantMessage) => message.stopReason === "stop" && !message.content.some(part => part.type === "toolCall");

/** Raw selected branch, not the compacted model projection or abandoned branches. */
export function restoreCloseReport(branch: SessionEntry[]): SavedReport | undefined {
	let saved: SavedReport | undefined;
	let latest: { id: string; message: AssistantMessage } | undefined;
	for (const entry of branch) {
		if (entry.type === "message") {
			// Any new conversation activity invalidates an older report until a settled record follows.
			if (entry.message.role !== "system") {
				saved = undefined;
				latest = entry.message.role === "assistant" ? { id: entry.id, message: entry.message } : undefined;
			}
		} else if (entry.type === "custom_message" || entry.type === "branch_summary" || entry.type === "context_edit") {
			saved = undefined;
			latest = undefined;
		} else if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
			const value = entry.data as Partial<SavedReport> | undefined;
			saved = undefined;
			// Reports from the old policy can be green while a required live sync is pending.
			if (value?.version !== 2 || typeof value.at !== "number" || !Number.isFinite(value.at) || value.at < 0 || value.at > 8.64e15) continue;
			if (!value.report) { saved = { version: 2, at: value.at }; continue; }
			const source = value.sourceId === latest?.id ? latest?.message : undefined;
			if (!source || !validReply(source) || value.provider !== source.provider || value.model !== source.model) continue;
			const report = parseCloseReport(replyText(source));
			if (!report || report.safe_to_close !== value.report.safe_to_close || report.close_reason !== value.report.close_reason || report.next_action !== value.report.next_action) continue;
			saved = { version: 2, report, sourceId: value.sourceId, provider: source.provider, model: source.model, at: value.at };
		}
	}
	return saved;
}

export default function closeStatus(pi: ExtensionAPI) {
	let saved: SavedReport | undefined;
	let candidate: { message: AssistantMessage; id: string } | undefined;
	let working = false;
	let active = false;
	const display = (ctx: ExtensionContext) => {
		if (!terminal(ctx)) return;
		const state = saved?.report?.safe_to_close ?? "unknown";
		ctx.ui.setStatus(CLOSE_STATUS_KEY, working ? undefined : state === "yes" ? "Safe to close (reported)" : state === "no" ? "Not safe to close" : "Close status unknown");
	};
	const restore = (ctx: ExtensionContext) => {
		if (!terminal(ctx)) return;
		saved = restoreCloseReport(ctx.sessionManager.getBranch());
		candidate = undefined;
		working = !ctx.isIdle();
		display(ctx);
	};
	pi.on("session_start", (_event, ctx) => { active = terminal(ctx); if (active) restore(ctx); });
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_compact", (_event, ctx) => { if (!working) restore(ctx); });
	const invalidate = (ctx: ExtensionContext) => {
		if (!terminal(ctx)) return;
		saved = undefined;
		candidate = undefined;
		display(ctx);
	};
	pi.on("input", (_event, ctx) => invalidate(ctx));
	pi.on("user_bash", (_event, ctx) => invalidate(ctx));
	pi.on("before_agent_start", (event, ctx) => {
		if (!terminal(ctx)) return;
		invalidate(ctx);
		event.systemPromptOptions.sections.close_status = CLOSE_GUIDANCE;
	});
	pi.on("agent_start", (_event, ctx) => { if (terminal(ctx)) { candidate = undefined; working = true; display(ctx); } });
	pi.on("agent_end", (event, ctx) => {
		if (!terminal(ctx)) return;
		candidate = undefined;
		const last = event.messages.findLast(message => message.role === "assistant") as AssistantMessage | undefined;
		if (!last || !validReply(last)) return;
		// A bounded metadata walk avoids both a full branch scan and an actionable turn_end hook.
		// The latter makes Pi build boundary projections on every tool turn.
		let entry = ctx.sessionManager.getLeafEntry();
		for (let i = 0; entry && i < 64; i++, entry = entry.parentId ? ctx.sessionManager.getEntry(entry.parentId) : undefined) {
			if (entry.type === "message" && entry.message.role !== "system") {
				if (entry.message.role === "assistant" && sameReply(entry.message, last)) candidate = { message: last, id: entry.id };
				break;
			}
			if (entry.type === "custom_message" || entry.type === "context_edit" || entry.type === "branch_summary") break;
		}
	});
	pi.on("agent_settled", (event, ctx) => {
		if (!terminal(ctx)) return;
		working = false;
		let source: SessionEntry | undefined;
		let entry = ctx.sessionManager.getLeafEntry();
		for (let i = 0; candidate && entry && i < 64; i++, entry = entry.parentId ? ctx.sessionManager.getEntry(entry.parentId) : undefined) {
			if (entry.id === candidate.id) { source = entry; break; }
			if (entry.type === "custom_message" || entry.type === "context_edit" || entry.type === "branch_summary" || entry.type === "message" && entry.message.role !== "system") break;
		}
		const report = !event.aborted && !ctx.hasPendingMessages() && source?.type === "message" && source.message.role === "assistant" && sameReply(source.message, candidate!.message)
			? parseCloseReport(replyText(source.message)) : undefined;
		saved = report ? { version: 2, report, sourceId: candidate!.id, provider: candidate!.message.provider, model: candidate!.message.model, at: Date.now() }
			: { version: 2, at: Date.now() };
		candidate = undefined;
		// Metadata records final settlement, including failed runs. It never reaches the model.
		pi.appendEntry(ENTRY_TYPE, saved);
		display(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (active && terminal(ctx)) ctx.ui.setStatus(CLOSE_STATUS_KEY, undefined);
		active = false; saved = undefined; candidate = undefined; working = false;
	});
	pi.registerCommand("close-status", {
		description: "Show this session's reported closing safety without a model call",
		handler: async (args, ctx) => {
			if (!terminal(ctx)) return;
			if (args.trim()) { ctx.ui.notify("Use /close-status without arguments.", "warning"); return; }
			const report = saved?.report;
			const text = [
				"Closing safety report",
				`Safe to close: ${working ? "Unknown (agent working)" : report?.safe_to_close === "yes" ? "Yes (reported)" : report?.safe_to_close === "no" ? "No (reported)" : "Unknown"}`,
				`Reason: ${working ? "This run has not settled." : report?.close_reason ?? "No valid final report for the current conversation branch."}`,
				`Next action: ${working ? "Wait for this run to settle." : report?.next_action ?? "Ask the agent for a fresh closing report."}`,
				...(report ? [`Reported: ${new Date(saved!.at).toISOString()}`, `Source: ${cleanSource(saved!.provider!)}/${cleanSource(saved!.model!)}, message ${cleanSource(saved!.sourceId!)}`] : []),
				"External changes are not monitored. This is an agent report, not verified live safety.",
				"Worktree: Keep this checkout. Removal safety has not been checked.",
				"Closing does not authorize publication, deployment, or worktree removal.",
			].join("\n\n");
			await ctx.ui.custom<void>((tui, theme, keys, done) => {
				const body = new Text(text, 0, 0);
				let top = 0;
				return {
					render(width) {
						const rows = body.render(width);
						const height = Math.max(1, Math.floor(tui.terminal.rows * 0.75) - 2);
						top = Math.min(top, Math.max(0, rows.length - height));
						return [...rows.slice(top, top + height), "", truncateToWidth(theme.fg("dim", "Up/Down scroll. Enter/Escape close."), width)];
					},
					handleInput(data) {
						if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.select.confirm")) { done(); return; }
						if (keys.matches(data, "tui.select.up")) top = Math.max(0, top - 1);
						else if (keys.matches(data, "tui.select.down")) top++;
						else return;
						tui.requestRender();
					},
					invalidate() { body.invalidate(); },
				};
			}, { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" } });
		},
	});
}
