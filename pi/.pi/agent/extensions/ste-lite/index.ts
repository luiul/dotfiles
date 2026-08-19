import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBaselineState, DEFAULT_WARMUP_COUNT, updateBaseline, type BaselineState } from "./baseline.ts";
import {
	createCandidateStore,
	pruneCandidates,
	recordCandidates,
	topCandidates,
	type CandidateStore,
} from "./candidates.ts";
import { NOT_APPROVED_WORDS } from "./dictionary.ts";
import {
	createHistoryState,
	mergeChannelHistory,
	seedBaselineFromHistory,
	type ChannelHistory,
	type HistoryState,
} from "./history.ts";
import { autofix, countWords, extractProseSpans, scoreText, stripMarkdownCode, type Finding } from "./scorer.ts";

// ste-lite: a lazy, deterministic ASD-STE100-style nudge for assistant
// replies and file-edit prose.
//
// It is lazy by design: it never enforces a fixed absolute writing bar.
// Instead it tracks a rolling per-session baseline (see baseline.ts) and
// only acts once quality *degrades* relative to this session's own recent
// output, for two consecutive samples. A session that starts wordy and
// stays wordy is left alone; a session that starts clean and drifts is not.
//
// It is token efficient: no rule card is ever injected repeatedly. The
// only injected text is a short (~40 word) one-shot reminder, fired at
// most once per degrade episode, via `before_agent_start` for the next
// turn only. Mechanical fixes (dictionary word swaps, filler-opener
// strips) are applied locally with zero LLM round trips.
//
// It never rewrites for meaning: autofix() only ever touches
// meaning-preserving, deterministic changes (see scorer.ts). Sentence
// length, passive voice, hedging, and prose-wall findings are reported,
// never rewritten.
//
// It improves over time in two ways, both cross-session (see history.ts
// and candidates.ts -- the per-session baseline alone does NOT improve on
// its own; it resets every session):
//   1. The degradation baseline is seeded from a persisted running mean
//      across every session that ever ran, so a returning session needs
//      only one real sample (not a full warmup) before it can judge
//      degradation.
//   2. Recurring soft findings (hedge/puffery/opener phrases, never the
//      content-derived ones) are tallied across sessions. `/ste-lite
//      candidates` surfaces the most frequent ones; `/ste-lite promote`
//      lets a human turn a recurring one into a hard, auto-fixed
//      dictionary entry. The word list only grows when a person decides
//      it should.
//
// It defaults to "observe" mode (log only, no visible behavior change)
// so thresholds can be calibrated against real sessions before switching
// to "nudge". See ../README.md for the rollout plan and rationale.

type Mode = "observe" | "nudge" | "strict";

interface SteLiteConfig {
	enabled: boolean;
	mode: Mode;
	scope: { replies: boolean; edits: boolean };
}

const AGENT_DIR = join(homedir(), ".pi", "agent");
const DATA_DIR = join(AGENT_DIR, "data", "ste-lite");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const LOG_PATH = join(DATA_DIR, "observations.log");
const HISTORY_PATH = join(DATA_DIR, "history.json");
const CANDIDATES_PATH = join(DATA_DIR, "candidates.json");
const CUSTOM_DICTIONARY_PATH = join(DATA_DIR, "custom-dictionary.json");
const MAX_LOG_BYTES = 512 * 1024;
const MAX_LOG_LINES_KEPT = 200;
const MIN_WORDS_TO_SCORE = 20;
const MAX_CANDIDATE_ENTRIES = 200;
const FLUSH_EVERY_N_OBSERVATIONS = 15;

const DEFAULT_CONFIG: SteLiteConfig = Object.freeze({
	enabled: true,
	mode: "observe",
	scope: { replies: true, edits: true },
});

function isEnvDisabled(): boolean {
	const value = process.env.STE_LITE_DISABLE;
	return value === "1" || value === "true";
}

function ensureDataDir(): void {
	try {
		mkdirSync(DATA_DIR, { recursive: true });
	} catch {
		// best-effort; a failure here surfaces as a failed read/write below
	}
}

function readJson<T>(path: string, fallback: T): T {
	try {
		return { ...fallback, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<T>) };
	} catch {
		return fallback;
	}
}

function writeJson(path: string, value: unknown): void {
	try {
		ensureDataDir();
		writeFileSync(path, JSON.stringify(value, null, 2));
	} catch {
		// non-fatal; the change just will not persist across restarts
	}
}

function readConfig(): SteLiteConfig {
	const parsed = readJson<Partial<SteLiteConfig>>(CONFIG_PATH, {});
	const config: SteLiteConfig = {
		enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
		mode: (parsed.mode as Mode) ?? DEFAULT_CONFIG.mode,
		scope: { ...DEFAULT_CONFIG.scope, ...parsed.scope },
	};
	if (!existsSync(CONFIG_PATH)) writeJson(CONFIG_PATH, config);
	return config;
}

function writeConfig(config: SteLiteConfig): void {
	writeJson(CONFIG_PATH, config);
}

function loadHistory(): HistoryState {
	const fallback = createHistoryState();
	const parsed = readJson<Partial<HistoryState>>(HISTORY_PATH, {});
	return {
		replies: { ...fallback.replies, ...parsed.replies },
		edits: { ...fallback.edits, ...parsed.edits },
	};
}

function saveHistory(history: HistoryState): void {
	writeJson(HISTORY_PATH, history);
}

function loadCandidates(): CandidateStore {
	return readJson<CandidateStore>(CANDIDATES_PATH, createCandidateStore());
}

function saveCandidates(store: CandidateStore): void {
	writeJson(CANDIDATES_PATH, store);
}

function loadCustomDictionary(): Record<string, string> {
	return readJson<Record<string, string>>(CUSTOM_DICTIONARY_PATH, {});
}

function saveCustomDictionary(dictionary: Record<string, string>): void {
	writeJson(CUSTOM_DICTIONARY_PATH, dictionary);
}

function effectiveDictionary(): Readonly<Record<string, string>> {
	return { ...NOT_APPROVED_WORDS, ...loadCustomDictionary() };
}

function logObservation(entry: Record<string, unknown>): void {
	try {
		ensureDataDir();
		if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > MAX_LOG_BYTES) {
			const lines = readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean);
			writeFileSync(LOG_PATH, `${lines.slice(-MAX_LOG_LINES_KEPT).join("\n")}\n`);
		}
		writeFileSync(LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { flag: "a" });
	} catch {
		// observation logging is best-effort; it must never break the hook chain
	}
}

interface TextPart {
	type: "text";
	text: string;
}

function isTextPart(part: unknown): part is TextPart {
	return !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string";
}

function extractReplyProse(content: unknown): string {
	if (typeof content === "string") return stripMarkdownCode(content);
	if (Array.isArray(content)) {
		return content
			.filter(isTextPart)
			.map((part) => stripMarkdownCode(part.text))
			.join("\n\n");
	}
	return "";
}

function topFindingRules(findings: readonly Finding[], limit = 2): string[] {
	const seen = new Set<string>();
	for (const finding of findings) {
		if (seen.size >= limit) break;
		seen.add(finding.rule);
	}
	return [...seen];
}

const RULE_HINTS: Readonly<Record<string, string>> = Object.freeze({
	"dictionary/not-approved-word": "swap flagged words for their plain equivalent",
	"length/sentence": "split long sentences, one idea per sentence",
	"style/hedge": "cut hedging phrases",
	"style/opener": "skip the warm-up opener, start with the point",
	"style/puffery": "drop marketing adjectives",
	"verb/passive": "prefer active voice",
	"structure/prose-wall": "use short paragraphs or bullets over long walls of text",
});

function buildReminder(findings: readonly Finding[]): string {
	const rules = topFindingRules(findings);
	const hints = rules.map((rule) => RULE_HINTS[rule] ?? rule).join("; ");
	return `Style check: recent output trended away from Simplified Technical English (${hints || "long, hedgy phrasing"}). Prefer short, direct, ASD-STE100-style sentences: one idea per sentence, active voice, no filler.`;
}

function applyReplyAutofix(content: unknown, dictionary: Readonly<Record<string, string>>): { content: unknown; changes: number } | null {
	if (typeof content === "string") {
		const fixed = autofix(content, dictionary);
		return fixed.changes.length > 0 ? { content: fixed.text, changes: fixed.changes.length } : null;
	}
	if (Array.isArray(content)) {
		let totalChanges = 0;
		const nextContent = content.map((part) => {
			if (!isTextPart(part)) return part;
			const fixed = autofix(part.text, dictionary);
			totalChanges += fixed.changes.length;
			return fixed.changes.length > 0 ? { ...part, text: fixed.text } : part;
		});
		return totalChanges > 0 ? { content: nextContent, changes: totalChanges } : null;
	}
	return null;
}

// Per-process session state. One pi process normally holds one active
// session; session_start (covering "startup" | "new" | "resume" | "fork" |
// "reload") reseeds these from persisted history so state never leaks
// across a session switch, but a returning session still starts informed
// by everything scored before it -- see history.ts.
let repliesState: BaselineState = createBaselineState();
let editsState: BaselineState = createBaselineState();
let pendingReminder: string | null = null;
let candidateStore: CandidateStore = createCandidateStore();
let repliesSum = 0;
let repliesCount = 0;
let editsSum = 0;
let editsCount = 0;
let observationsSinceFlush = 0;

function resetSessionState(): void {
	const history = loadHistory();
	repliesState = seedBaselineFromHistory(history.replies, DEFAULT_WARMUP_COUNT);
	editsState = seedBaselineFromHistory(history.edits, DEFAULT_WARMUP_COUNT);
	pendingReminder = null;
	candidateStore = loadCandidates();
	repliesSum = 0;
	repliesCount = 0;
	editsSum = 0;
	editsCount = 0;
	observationsSinceFlush = 0;
}

/** Folds this session's accumulated scores into persisted history, then
 * resets the accumulators so a later flush in the same session never
 * double-counts the samples already folded in. Safe to call repeatedly
 * (a no-op merge when a channel has no new samples) and safe to call from
 * both the periodic safety net and session_shutdown. */
function flushHistory(): void {
	try {
		const history = loadHistory();
		const nextReplies: ChannelHistory =
			repliesCount > 0 ? mergeChannelHistory(history.replies, repliesSum / repliesCount, repliesCount) : history.replies;
		const nextEdits: ChannelHistory = editsCount > 0 ? mergeChannelHistory(history.edits, editsSum / editsCount, editsCount) : history.edits;
		saveHistory({ replies: nextReplies, edits: nextEdits });
		repliesSum = 0;
		repliesCount = 0;
		editsSum = 0;
		editsCount = 0;
	} catch {
		// best-effort; losing one flush just delays learning, never breaks scoring
	}
}

function maybeFlush(): void {
	observationsSinceFlush += 1;
	if (observationsSinceFlush < FLUSH_EVERY_N_OBSERVATIONS) return;
	observationsSinceFlush = 0;
	flushHistory();
	saveCandidates(candidateStore);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		resetSessionState();
	});

	pi.on("session_shutdown", () => {
		try {
			flushHistory();
			saveCandidates(candidateStore);
		} catch {
			// best-effort; nothing left to do on the way out
		}
	});

	pi.on("message_end", async (event: any, ctx: ExtensionContext) => {
		try {
			if (isEnvDisabled()) return undefined;
			if (event.message?.role !== "assistant") return undefined;

			const config = readConfig();
			if (!config.enabled || !config.scope.replies) return undefined;

			const prose = extractReplyProse(event.message.content);
			if (countWords(prose) < MIN_WORDS_TO_SCORE) return undefined;

			const dictionary = effectiveDictionary();
			const { score, findings } = scoreText(prose, dictionary);
			const update = updateBaseline(repliesState, score);
			repliesState = update.state;

			repliesSum += score;
			repliesCount += 1;
			candidateStore = pruneCandidates(recordCandidates(candidateStore, findings, new Date().toISOString()), MAX_CANDIDATE_ENTRIES);
			maybeFlush();

			logObservation({
				channel: "reply",
				mode: config.mode,
				score: Math.round(score * 100) / 100,
				wordCount: countWords(prose),
				findingCount: findings.length,
				degrading: update.degrading,
				shouldIntervene: update.shouldIntervene,
				recovered: update.recovered,
			});

			if (config.mode === "observe") return undefined;
			if (!update.shouldIntervene) return undefined;

			const fixResult = applyReplyAutofix(event.message.content, dictionary);
			if (fixResult) {
				ctx.ui.notify(`ste-lite: tightened wording (${fixResult.changes} mechanical fix${fixResult.changes === 1 ? "" : "es"})`, "info");
				logObservation({ channel: "reply", action: "autofix", changes: fixResult.changes });

				const refixed = scoreText(extractReplyProse(fixResult.content), dictionary);
				const stillDegrading = updateBaseline(update.state, refixed.score).degrading;
				if (stillDegrading) {
					pendingReminder = buildReminder(refixed.findings);
				}
				return { message: { ...event.message, content: fixResult.content } };
			}

			ctx.ui.notify("ste-lite: reply is trending long/hedgy — tighten up", "info");
			pendingReminder = buildReminder(findings);
			return undefined;
		} catch (err) {
			logObservation({ channel: "reply", action: "error", error: err instanceof Error ? err.message : String(err) });
			return undefined;
		}
	});

	pi.on("before_agent_start", async (event: any) => {
		try {
			if (isEnvDisabled() || !pendingReminder) return undefined;
			const config = readConfig();
			if (!config.enabled || config.mode === "observe") return undefined;

			const reminder = pendingReminder;
			pendingReminder = null;
			return { systemPrompt: `${event.systemPrompt}\n\n${reminder}` };
		} catch {
			pendingReminder = null;
			return undefined;
		}
	});

	pi.on("tool_call", async (event: any, ctx: ExtensionContext) => {
		try {
			if (isEnvDisabled()) return undefined;
			const config = readConfig();
			if (!config.enabled || !config.scope.edits) return undefined;

			let path: string | undefined;
			let newProseSource: string | undefined;

			if (isToolCallEventType("write", event)) {
				path = event.input.path;
				newProseSource = event.input.content;
			} else if (isToolCallEventType("edit", event)) {
				path = event.input.path;
				newProseSource = (event.input.edits ?? []).map((e: { newText: string }) => e.newText).join("\n\n");
			} else {
				return undefined;
			}

			if (!path || !newProseSource) return undefined;
			const prose = extractProseSpans(path, newProseSource);
			if (countWords(prose) < MIN_WORDS_TO_SCORE) return undefined;

			const dictionary = effectiveDictionary();
			const { score, findings } = scoreText(prose, dictionary);
			const update = updateBaseline(editsState, score);
			editsState = update.state;

			editsSum += score;
			editsCount += 1;
			candidateStore = pruneCandidates(recordCandidates(candidateStore, findings, new Date().toISOString()), MAX_CANDIDATE_ENTRIES);
			maybeFlush();

			logObservation({
				channel: "edit",
				path,
				mode: config.mode,
				score: Math.round(score * 100) / 100,
				findingCount: findings.length,
				degrading: update.degrading,
				shouldIntervene: update.shouldIntervene,
			});

			if (config.mode === "observe" || !update.shouldIntervene) return undefined;

			const onlyUnambiguousHardFindings = findings.every((f) => f.rule === "dictionary/not-approved-word" && f.suggestion);
			if (config.mode === "strict" && findings.length > 0 && onlyUnambiguousHardFindings) {
				const swaps = [...new Set(findings.map((f) => `${f.excerpt} -> ${f.suggestion}`))].slice(0, 5).join(", ");
				return { block: true, reason: `ste-lite: not-approved word(s) in new prose (${swaps}). Use the approved word and retry.` };
			}

			ctx.ui.notify(`ste-lite: new prose in ${path} is trending away from plain style`, "info");
			return undefined;
		} catch (err) {
			logObservation({ channel: "edit", action: "error", error: err instanceof Error ? err.message : String(err) });
			return undefined;
		}
	});

	pi.registerCommand("ste-lite", {
		description:
			"Check or change ste-lite's simplified-English guard (status | on | off | mode <observe|nudge|strict> | reset | history | candidates [n] | promote <word> <replacement>)",
		getArgumentCompletions(prefix: string) {
			const options = [
				"status",
				"on",
				"off",
				"mode observe",
				"mode nudge",
				"mode strict",
				"reset",
				"history",
				"candidates",
				"promote",
			];
			const items = options.filter((o) => o.startsWith(prefix)).map((v) => ({ value: v, label: v }));
			return items.length > 0 ? items : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			try {
				const trimmed = args.trim();
				const config = readConfig();

				if (trimmed === "" || trimmed === "status") {
					const envNote = isEnvDisabled() ? " (STE_LITE_DISABLE overrides: fully off)" : "";
					ctx.ui.notify(
						`ste-lite: ${config.enabled ? "enabled" : "disabled"}, mode=${config.mode}, replies=${config.scope.replies}, edits=${config.scope.edits}${envNote}`,
						"info",
					);
					return;
				}
				if (trimmed === "on") {
					writeConfig({ ...config, enabled: true });
					ctx.ui.notify("ste-lite: enabled", "info");
					return;
				}
				if (trimmed === "off") {
					writeConfig({ ...config, enabled: false });
					ctx.ui.notify("ste-lite: disabled", "info");
					return;
				}
				const modeMatch = /^mode\s+(observe|nudge|strict)$/.exec(trimmed);
				if (modeMatch) {
					writeConfig({ ...config, mode: modeMatch[1] as Mode });
					ctx.ui.notify(`ste-lite: mode set to ${modeMatch[1]}`, "info");
					return;
				}
				if (trimmed === "reset") {
					resetSessionState();
					ctx.ui.notify("ste-lite: session baseline reset (reseeded from persisted history)", "info");
					return;
				}
				if (trimmed === "history") {
					const history = loadHistory();
					ctx.ui.notify(
						`ste-lite history: replies mean=${history.replies.mean.toFixed(2)} (n=${history.replies.count}), edits mean=${history.edits.mean.toFixed(2)} (n=${history.edits.count})`,
						"info",
					);
					return;
				}
				const candidatesMatch = /^candidates(?:\s+(\d+))?$/.exec(trimmed);
				if (candidatesMatch) {
					const limit = candidatesMatch[1] ? Number.parseInt(candidatesMatch[1], 10) : 10;
					const top = topCandidates(candidateStore, limit);
					if (top.length === 0) {
						ctx.ui.notify("ste-lite: no recurring candidates tracked yet", "info");
						return;
					}
					const lines = top.map((c) => `${c.rule} "${c.excerpt}" x${c.count}`).join("\n");
					ctx.ui.notify(`ste-lite candidates (promote with /ste-lite promote <word> <replacement>):\n${lines}`, "info");
					return;
				}
				const promoteMatch = /^promote\s+(\S+)\s+(.+)$/.exec(trimmed);
				if (promoteMatch) {
					const [, word, replacement] = promoteMatch;
					if (!/^[a-zA-Z][a-zA-Z'-]*$/.test(word)) {
						ctx.ui.notify(`ste-lite: "${word}" is not a single plain word, refusing to promote`, "warning");
						return;
					}
					if (NOT_APPROVED_WORDS[word.toLowerCase()]) {
						ctx.ui.notify(`ste-lite: "${word}" is already a built-in not-approved word`, "warning");
						return;
					}
					const custom = loadCustomDictionary();
					custom[word.toLowerCase()] = replacement.trim();
					saveCustomDictionary(custom);
					ctx.ui.notify(`ste-lite: promoted "${word}" -> "${replacement.trim()}" (hard, auto-fixed from now on)`, "info");
					return;
				}
				ctx.ui.notify(
					"ste-lite: usage: /ste-lite [status|on|off|mode <observe|nudge|strict>|reset|history|candidates [n]|promote <word> <replacement>]",
					"warning",
				);
			} catch (err) {
				ctx.ui.notify(`ste-lite: command failed (${err instanceof Error ? err.message : "unknown error"})`, "error");
			}
		},
	});
}
