import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Settings = ReturnType<ExtensionAPI["getSettings"]>;
type ScopeItem = ExtensionContext["scopedModels"][number];
export type LocalEvidence = {
	date: string;
	effort: string;
	source: string;
	small: { runs: number; passed: number; checked: number; totalUsd: number; note: string };
	grove: { runs: number; passed: number; timedOut: number; totalUsd: number };
};
export type Evidence = {
	score: number;
	benchmark: string;
	version: string;
	effort: string;
	reviewed: string;
	url: string;
	qualifier?: string;
	local?: LocalEvidence;
};
export type GuideData = { evidence: Record<string, Evidence>; warning?: string };
export type GuideRow = {
	key: string;
	model: ScopeItem["model"];
	role: string;
	purpose: string;
	configured?: string;
	effortSource: string;
	current?: string;
	evidence?: Evidence;
};

// Remove terminal controls from display metadata, including OSC escape payloads.
// Evidence is local and reviewed, but malformed files must not control the TUI.
export function plain(value: string): string {
	return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
}

function validDate(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
		&& Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function parseLocal(raw: LocalEvidence | undefined): LocalEvidence | undefined {
	if (!raw || !validDate(raw.date) || !levels.has(raw.effort)
		|| typeof raw.source !== "string" || raw.source.length > 600 || !/^https:\/\/\S+$/.test(raw.source)) return;
	const s = raw.small, g = raw.grove;
	const count = (n: number) => Number.isInteger(n) && n >= 0 && n <= 100;
	const cost = (n: number) => Number.isFinite(n) && n >= 0;
	if (!s || !g || ![s.runs, s.passed, s.checked, g.runs, g.passed, g.timedOut].every(count)
		|| s.runs < 1 || s.checked > s.runs || s.passed > s.checked || g.runs < 1 || g.passed + g.timedOut > g.runs
		|| !cost(s.totalUsd) || !cost(g.totalUsd) || typeof s.note !== "string" || s.note.length > 600) return;
	return { date: raw.date, effort: raw.effort, source: plain(raw.source),
		small: { runs: s.runs, passed: s.passed, checked: s.checked, totalUsd: s.totalUsd, note: plain(s.note) },
		grove: { runs: g.runs, passed: g.passed, timedOut: g.timedOut, totalUsd: g.totalUsd } };
}

export function parseEvidence(text: string): GuideData {
	try {
		const doc = JSON.parse(text);
		if (doc?.version !== 1 || !doc.models || typeof doc.models !== "object" || Array.isArray(doc.models)) {
			throw new Error("invalid schema");
		}
		const evidence: Record<string, Evidence> = Object.create(null);
		let invalid = 0, invalidLocal = 0;
		for (const [key, raw] of Object.entries(doc.models)) {
			const e = raw as Evidence;
			const fields = [e?.benchmark, e?.version, e?.effort, e?.reviewed, e?.url];
			const date = validDate(e?.reviewed);
			if (!key.includes("/") || !Number.isFinite(e?.score) || e.score < 0 || e.score > 100
				|| fields.some(x => typeof x !== "string" || !x.trim() || x.length > 600)
				|| !date || !/^https:\/\/\S+$/.test(e.url)
				|| (e.qualifier !== undefined && (typeof e.qualifier !== "string" || e.qualifier.length > 600))) {
				invalid++;
				continue;
			}
			const local = parseLocal(e.local);
			if (e.local !== undefined && !local) invalidLocal++;
			evidence[key] = { score: e.score, benchmark: plain(e.benchmark), version: plain(e.version), effort: plain(e.effort),
				reviewed: e.reviewed, url: plain(e.url), ...(e.qualifier ? { qualifier: plain(e.qualifier) } : {}),
				...(local ? { local } : {}) };
		}
		const warnings = [invalid ? `${invalid} invalid public evidence record(s) ignored.` : "",
			invalidLocal ? `${invalidLocal} invalid local snapshot(s) ignored; public evidence retained.` : ""].filter(Boolean);
		return { evidence, ...(warnings.length ? { warning: warnings.join(" ") } : {}) };
	} catch {
		return { evidence: {}, warning: "Evidence file is invalid. Catalog details remain available." };
	}
}

export async function loadEvidence(path: string | URL): Promise<GuideData> {
	try {
		return parseEvidence(await readFile(path, "utf8"));
	} catch {
		return { evidence: {}, warning: "Evidence file is unavailable. Catalog details remain available." };
	}
}

const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export function guideRows(scope: readonly ScopeItem[], settings: Settings, activeKey: string | undefined,
	current: string, evidence: Record<string, Evidence>): GuideRow[] {
	return scope.map(item => {
		const model = item.model;
		const key = `${model.provider}/${model.id}`;
		const parts = model.name?.match(/^([^|]+)\s*\|\s*(.+)$/);
		const pattern = levels.has(item.thinkingLevel ?? "") ? item.thinkingLevel : undefined;
		const pin = settings.modelThinkingLevels?.[key];
		const configured = pattern ?? (levels.has(pin ?? "") ? pin : undefined);
		return { key, model, role: parts ? plain(parts[1]) : "", purpose: parts ? plain(parts[2]) : "",
			configured, effortSource: pattern ? "scope pattern" : configured ? "model pin" : "no model pin",
			...(key === activeKey ? { current } : {}), evidence: evidence[key] };
	});
}

export function intelligence(row: GuideRow): { text: string; warning: boolean } {
	const e = row.evidence;
	if (!e) return { text: "II unknown", warning: true };
	if (!row.configured || e.effort !== row.configured) {
		return { text: `II unknown at ${row.configured ?? "unpinned effort"}; published ${e.score} @ ${e.effort}`,
			warning: true };
	}
	return { text: `II ${e.score} @ ${e.effort}`, warning: false };
}

export function price(value: number | undefined): string {
	if (!Number.isFinite(value) || value! < 0) return "unknown";
	return value === 0 ? "$0 (catalog)" : `$${value}`;
}

export function detailLines(row: GuideRow, today = new Date().toISOString().slice(0, 10)): { text: string; warning?: boolean }[] {
	const ii = intelligence(row), e = row.evidence, m = row.model;
	const lines: { text: string; warning?: boolean }[] = [
		{ text: plain(row.key) },
		{ text: `Configured: ${row.configured ?? "unpinned"} (${row.effortSource})${row.current ? `; current: ${row.current}` : ""}` },
		{ text: row.purpose ? `Use: ${row.purpose}` : "Use: no curated purpose" },
		{ text: ii.text, warning: ii.warning },
		{ text: `Catalog $/M: in ${price(m.cost?.input)}; out ${price(m.cost?.output)}` },
		{ text: `Cache $/M: read ${price(m.cost?.cacheRead)}; write ${price(m.cost?.cacheWrite)}` },
		{ text: `Context: ${Number.isFinite(m.contextWindow) ? m.contextWindow.toLocaleString("en-US") : "unknown"} tokens` },
	];
	if (e) {
		lines.push({ text: `${e.benchmark} ${e.version}; benchmark effort: ${e.effort}` },
			{ text: `Reviewed: ${e.reviewed}${e.reviewed > today ? " (future date; verify)" : " (manual snapshot)"}`, warning: e.reviewed > today },
			{ text: `Source: ${e.url}` });
		if (e.qualifier) lines.push({ text: e.qualifier, warning: true });
	}
	if (e?.local) lines.push({ text: `Local tests: ${e.local.date}, ${e.local.effort}; source: ${e.local.source}` });
	lines.push({ text: "Rates are catalog values, not task cost. Zero is not proof of free usage." },
		{ text: "Unpinned effort follows Pi's defaults/current fallback. Selection clamps effort to model capabilities." });
	return lines;
}
