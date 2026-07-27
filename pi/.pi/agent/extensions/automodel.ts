/**
 * Automatic plan/execute model switching ("opusplan"-style, but automatic).
 *
 * Claude Code's `opusplan` setting uses Opus while you're in plan mode and
 * Sonnet once you start executing. pi has no built-in equivalent, and no
 * mode concept to hang it on -- so this infers the mode from context instead
 * of requiring a manual toggle:
 *
 *   - A mutating tool (`edit`, `write`, or a `bash` command not on the
 *     read-only allowlist) is about to run -> switch to `executeModel`.
 *     This is the primary, deterministic signal.
 *   - The new user prompt clearly signals planning or execution intent
 *     (keyword match against `planIntentPhrases`/`executeIntentPhrases` in
 *     automodel.json, e.g. bare "plan"/"execute" as whole words, or phrases
 *     like "let's plan"/"plan:") -> switch to the matching model. This only
 *     fires on explicit phrasing; it never forces a default mode on a fresh
 *     session.
 *
 * Once switched to "execute", the mode is sticky (a `read`/`grep`/etc. call
 * does not bounce it back to "plan") -- only a planning-intent prompt or a
 * manual `/automodel` command moves it back.
 *
 * context-mode's tools (ctx_execute, ctx_search, ...) are explicitly for
 * analysis, not edits (see its own skill docs), so they're classified
 * read-only here and never trigger a switch to execute on their own.
 *
 * TESTING MODE: every switch asks for confirmation via `ctx.ui.confirm`
 * before calling `pi.setModel()` (see `requireConfirmation` in
 * automodel.json). Turn this off once you trust the classification.
 *
 * Config: ~/.pi/agent/automodel.json (see automodel.json next to this file
 * in the dotfiles repo). Reloaded on session_start and via `/automodel reload`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "automodel.json");

type Mode = "plan" | "execute";
type Classification = "mutating" | "readonly" | "neutral";

interface ModelRef {
	provider: string;
	model: string;
}

interface AutoModelConfig {
	enabled: boolean;
	requireConfirmation: boolean;
	planModel: ModelRef;
	executeModel: ModelRef;
	mutatingTools: string[];
	readOnlyBashPrefixes: string[];
	executeIntentPhrases: string[];
	planIntentPhrases: string[];
}

const DEFAULT_CONFIG: AutoModelConfig = {
	enabled: true,
	requireConfirmation: true,
	planModel: { provider: "amazon-bedrock", model: "eu.anthropic.claude-opus-5" },
	executeModel: { provider: "amazon-bedrock", model: "eu.anthropic.claude-sonnet-5" },
	mutatingTools: ["edit", "write"],
	readOnlyBashPrefixes: ["ls", "cat", "pwd", "which", "echo", "find", "grep", "git status", "git log", "git diff"],
	executeIntentPhrases: [
		"implement it", "go ahead", "proceed", "fix it",
		"execute:", "implement:", "build:", "fix:", "do:", "apply:", "ship:",
		"write:", "create:", "add:", "update:", "remove:", "delete:",
		"refactor:", "migrate:", "deploy:", "run:",
		"execute", "implement",
	],
	planIntentPhrases: [
		"let's plan", "propose a plan", "investigate", "give me a plan",
		"plan:", "investigate:", "research:", "explore:", "analyze:", "analyse:",
		"review:", "propose:", "outline:", "design:", "draft:", "assess:", "audit:",
		"plan",
	],
};

// context-mode tools are for analysis, not edits (per their own skill docs) --
// never trigger a switch to execute on their own.
const ALWAYS_READONLY_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"ctx_execute",
	"ctx_execute_file",
	"ctx_batch_execute",
	"ctx_search",
	"ctx_index",
	"ctx_fetch_and_index",
	"ctx_stats",
	"ctx_doctor",
	"ctx_purge",
	"ctx_insight",
	"ctx_upgrade",
]);

function loadConfig(): AutoModelConfig {
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<AutoModelConfig>;
		return { ...DEFAULT_CONFIG, ...raw };
	} catch {
		// Missing/unreadable config: fall back to built-in defaults rather than failing.
		return DEFAULT_CONFIG;
	}
}

function classifyTool(toolName: string, input: unknown, config: AutoModelConfig): Classification {
	if (config.mutatingTools.includes(toolName)) return "mutating";
	if (ALWAYS_READONLY_TOOLS.has(toolName)) return "readonly";
	if (toolName === "bash") {
		const command = String((input as { command?: string })?.command ?? "").trim();
		const isReadOnly = config.readOnlyBashPrefixes.some((prefix) => command.startsWith(prefix));
		return isReadOnly ? "readonly" : "mutating";
	}
	// Everything else (memory, skill_manage, slack_*, kb_*, drawio_*, excalidraw_*, the
	// generic mcp gateway, ...) is a side effect unrelated to code plan/execute -- ignore it.
	return "neutral";
}

// Substring match, but bounded on both sides so bare keywords (e.g. "plan", "execute") only
// match as whole words, not as a prefix buried in a longer one:
//   - left boundary: the phrase must start at the beginning of the text or be preceded by
//     whitespace/punctuation, not a word character (so "do:" doesn't match inside "todo:").
//   - right boundary: only enforced when the phrase itself ends in a word character (letters/
//     digits) -- this stops "plan" from matching inside "planning"/"plant" or "execute" inside
//     "executive"/"executed", while leaving colon-terminated phrases like "plan:" untouched
//     (the colon already unambiguously terminates the keyword).
function matchesAny(text: string, phrases: string[]): boolean {
	const lower = text.toLowerCase();
	return phrases.some((phrase) => {
		const needle = phrase.toLowerCase();
		const idx = lower.indexOf(needle);
		if (idx === -1) return false;

		const before = idx === 0 ? undefined : lower[idx - 1];
		if (before !== undefined && /[a-z0-9_]/.test(before)) return false;

		const lastChar = needle[needle.length - 1];
		if (/[a-z0-9_]/.test(lastChar)) {
			const after = lower[idx + needle.length];
			if (after !== undefined && /[a-z0-9_]/.test(after)) return false;
		}
		return true;
	});
}

export default function (pi: ExtensionAPI) {
	let config: AutoModelConfig = loadConfig();
	let mode: Mode | undefined;
	let lastTrigger: string | undefined;
	// Targets the user declined via confirm, so we don't re-nag on every subsequent
	// tool call for the same reason. Cleared whenever a switch actually succeeds.
	const declined = new Set<Mode>();

	async function applyMode(
		target: Mode,
		reason: string,
		ctx: ExtensionContext,
		opts: { skipConfirm?: boolean } = {},
	): Promise<void> {
		if (!config.enabled) return;
		if (mode === target) return;
		if (!opts.skipConfirm && declined.has(target)) return;

		const ref = target === "plan" ? config.planModel : config.executeModel;
		const already = ctx.model?.provider === ref.provider && ctx.model?.id === ref.model;
		if (already) {
			// Nothing would actually change -- record the mode without prompting.
			mode = target;
			lastTrigger = reason;
			declined.clear();
			return;
		}

		const model = ctx.modelRegistry.find(ref.provider, ref.model);
		if (!model) {
			ctx.ui.notify(`automodel: model ${ref.provider}/${ref.model} not found, skipping switch`, "warning");
			return;
		}

		if (!opts.skipConfirm && config.requireConfirmation) {
			if (!ctx.hasUI) return; // no one to ask in print/json mode -- leave the model alone
			const ok = await ctx.ui.confirm(
				`Switch to ${target} model?`,
				`${ref.provider}/${ref.model}\nReason: ${reason}`,
			);
			if (!ok) {
				declined.add(target);
				ctx.ui.notify(`automodel: kept current model (declined switch to ${target})`, "info");
				return;
			}
		}

		const success = await pi.setModel(model);
		if (!success) {
			ctx.ui.notify(`automodel: no auth available for ${ref.provider}/${ref.model}`, "error");
			return;
		}

		mode = target;
		lastTrigger = reason;
		declined.clear();
		ctx.ui.notify(`automodel: switched to ${target} (${ref.model}) -- ${reason}`, "info");
		ctx.ui.setStatus("automodel", target === "plan" ? "auto:plan" : "auto:execute");
	}

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		mode = undefined;
		lastTrigger = undefined;
		declined.clear();
		ctx.ui.setStatus("automodel", undefined);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!config.enabled) return;
		const cls = classifyTool(event.toolName, event.input, config);
		if (cls === "mutating") {
			await applyMode("execute", `about to run ${event.toolName}`, ctx);
		}
		// readonly/neutral: no action -- mode is sticky once set to "execute".
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!config.enabled) return;
		const prompt = event.prompt ?? "";
		const wantsExecute = matchesAny(prompt, config.executeIntentPhrases);
		const wantsPlan = matchesAny(prompt, config.planIntentPhrases);

		if (wantsPlan && !wantsExecute) {
			await applyMode("plan", "prompt signals planning intent", ctx);
		} else if (wantsExecute && !wantsPlan && mode !== "execute") {
			await applyMode("execute", "prompt signals execution intent", ctx);
		}
		// Ambiguous or no match: leave mode/model alone. The tool_call signal
		// remains the deterministic fallback for actual mutations.
	});

	pi.registerCommand("automodel", {
		description: "Show or control automatic plan/execute model switching",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") {
				config.enabled = true;
				ctx.ui.notify("automodel: enabled", "info");
				return;
			}
			if (arg === "off") {
				config.enabled = false;
				ctx.ui.notify("automodel: disabled", "info");
				return;
			}
			if (arg === "plan" || arg === "execute") {
				await applyMode(arg as Mode, "manual /automodel command", ctx, { skipConfirm: true });
				return;
			}
			if (arg === "reload") {
				config = loadConfig();
				ctx.ui.notify("automodel: config reloaded", "info");
				return;
			}
			ctx.ui.notify(
				`automodel: ${config.enabled ? "on" : "off"} | mode=${mode ?? "(none)"} | ` +
					`last=${lastTrigger ?? "(none)"} | confirm=${config.requireConfirmation} | ` +
					`model=${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"}`,
				"info",
			);
		},
	});
}
