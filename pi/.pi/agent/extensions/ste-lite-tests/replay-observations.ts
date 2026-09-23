#!/usr/bin/env bun
// replay-observations.ts: replay a real ste-lite observations.log through the
// REAL extension code (baseline.ts + history.ts, the same functions index.ts
// calls at runtime) under different calibration options, and compare the
// intervention counts. This is the empirical calibration loop for ste-lite:
// no LLM calls, no mocks of the decision logic, just the logged scores from
// real sessions re-decided by the production code path.
//
// Usage:
//   bun pi/.pi/agent/extensions/ste-lite-tests/replay-observations.ts [log-path]
//
// Defaults to ~/.pi/agent/data/ste-lite/observations.log.
//
// Reconstruction caveats:
// - Log entries written before sessionId logging existed are grouped into
//   approximate sessions with a 45-minute-gap heuristic per channel. Entries
//   from concurrent pi processes interleave in the log, so reconstructed
//   sessions can merge two real sessions; absolute counts overstate somewhat
//   (replay of the old defaults lands above the actually-logged intervention
//   count). Entries that carry a sessionId are grouped by it exactly.
// - The per-channel baseline state is what a single pi process would hold;
//   cross-process history races are not modeled.
// Relative comparisons between variants use identical reconstruction, so the
// ordering and ratios are meaningful even where absolute counts drift.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { updateBaseline, type BaselineOptions } from "../ste-lite/baseline.ts";
import {
	createChannelHistory,
	mergeChannelHistory,
	seedBaselineFromHistory,
	type ChannelHistory,
} from "../ste-lite/history.ts";

interface Observation {
	ts: string;
	channel: string;
	score: number;
	sessionId?: string;
}

const logPath = process.argv[2] ?? join(homedir(), ".pi", "agent", "data", "ste-lite", "observations.log");

const entries = readFileSync(logPath, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => {
		try {
			return JSON.parse(line) as Partial<Observation>;
		} catch {
			return null;
		}
	})
	.filter((e): e is Observation => !!e && typeof e.score === "number" && typeof e.ts === "string")
	.sort((a, b) => (a.ts < b.ts ? -1 : 1));

const GAP_MS = 45 * 60 * 1000;
const FLUSH_EVERY = 15; // mirrors FLUSH_EVERY_N_OBSERVATIONS in index.ts

/** Split one channel's entries into sessions: exact by sessionId when the
 * entry carries one, 45-minute-gap heuristic otherwise (legacy entries). */
function splitSessions(obs: Observation[]): Observation[][] {
	const byId = new Map<string, Observation[]>();
	const legacy: Observation[] = [];
	for (const e of obs) {
		if (e.sessionId) {
			const list = byId.get(e.sessionId) ?? [];
			list.push(e);
			byId.set(e.sessionId, list);
		} else {
			legacy.push(e);
		}
	}
	const sessions: Observation[][] = [...byId.values()];
	let current: Observation[] = [];
	let previous: Observation | null = null;
	for (const e of legacy) {
		if (previous && new Date(e.ts).getTime() - new Date(previous.ts).getTime() > GAP_MS) {
			sessions.push(current);
			current = [];
		}
		current.push(e);
		previous = e;
	}
	if (current.length > 0) sessions.push(current);
	// Chronological order by first entry, so shared history evolves roughly
	// the way it did live.
	return sessions.sort((a, b) => (a[0].ts < b[0].ts ? -1 : 1));
}

interface SimResult {
	interventions: number;
	degrading: number;
	scored: number;
	sessionsWithIntervention: number;
	sessionCount: number;
	maxInOneSession: number;
	historyMean: number;
	historyCount: number;
}

function simulate(sessions: Observation[][], options: BaselineOptions & { warmupCount: number }): SimResult {
	let history: ChannelHistory = createChannelHistory();
	let interventions = 0;
	let degrading = 0;
	let scored = 0;
	const perSession: number[] = [];

	for (const session of sessions) {
		let state = seedBaselineFromHistory(history, options.warmupCount);
		let cleanSum = 0;
		let cleanCount = 0;
		let sinceFlush = 0;
		let sessionInterventions = 0;
		const flush = () => {
			if (cleanCount > 0) history = mergeChannelHistory(history, cleanSum / cleanCount, cleanCount);
			cleanSum = 0;
			cleanCount = 0;
		};

		for (const entry of session) {
			scored++;
			const update = updateBaseline(state, entry.score, options);
			state = update.state;
			if (update.degrading) degrading++;
			if (update.shouldIntervene) {
				interventions++;
				sessionInterventions++;
			}
			// Mirrors index.ts: only non-degrading samples feed cross-session history.
			if (!update.degrading) {
				cleanSum += entry.score;
				cleanCount++;
			}
			sinceFlush++;
			if (sinceFlush >= FLUSH_EVERY) {
				sinceFlush = 0;
				flush();
			}
		}
		flush();
		perSession.push(sessionInterventions);
	}

	return {
		interventions,
		degrading,
		scored,
		sessionsWithIntervention: perSession.filter((n) => n > 0).length,
		sessionCount: sessions.length,
		maxInOneSession: Math.max(0, ...perSession),
		historyMean: history.mean,
		historyCount: history.count,
	};
}

// The pre-change behavior, expressed in the new options vocabulary:
// frozen EWMA on degrading samples (degradingAlpha 0), no cooldown, no cap.
const OLD: BaselineOptions & { warmupCount: number } = {
	warmupCount: 4,
	degradeRatio: 1.5,
	degradeAbs: 4,
	streakThreshold: 2,
	alpha: 0.3,
	degradingAlpha: 0,
	cooldown: false,
	maxInterventions: -1,
};

// The shipped defaults from index.ts DEFAULT_CONFIG.
const SHIPPED: BaselineOptions & { warmupCount: number } = {
	warmupCount: 4,
	degradeRatio: 2,
	degradeAbs: 4,
	streakThreshold: 3,
	alpha: 0.3,
	degradingAlpha: 0.075,
	cooldown: true,
	maxInterventions: 3,
};

const VARIANTS: Array<[string, BaselineOptions & { warmupCount: number }]> = [
	["OLD  ratio=1.5 streak=2 frozen no-cooldown no-cap", OLD],
	["cap=3 only", { ...OLD, maxInterventions: 3 }],
	["cooldown only", { ...OLD, cooldown: true }],
	["adaptUp only (alpha=0.075)", { ...OLD, degradingAlpha: 0.075 }],
	["ratio=2 + streak=3 only", { ...OLD, degradeRatio: 2, streakThreshold: 3 }],
	["SHIPPED ratio=2 streak=3 adaptUp cooldown cap=3", SHIPPED],
];

const actualInterventions = (channel: string) =>
	readFileSync(logPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line) as { channel?: string; shouldIntervene?: boolean };
			} catch {
				return null;
			}
		})
		.filter((e) => !!e && e.channel === channel && e.shouldIntervene === true).length;

console.log(`log: ${logPath}`);
console.log(`scored entries: ${entries.length}\n`);

for (const channel of ["reply", "edit"]) {
	const channelEntries = entries.filter((e) => e.channel === channel);
	if (channelEntries.length === 0) continue;
	const sessions = splitSessions(channelEntries);
	const scores = channelEntries.map((e) => e.score).sort((a, b) => a - b);
	const q = (p: number) => scores[Math.min(scores.length - 1, Math.floor(p * scores.length))].toFixed(2);
	console.log(`=== ${channel} channel ===`);
	console.log(
		`entries=${channelEntries.length} sessions~=${sessions.length} score p25=${q(0.25)} median=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)}`,
	);
	console.log(`actually logged interventions: ${actualInterventions(channel)}`);
	for (const [name, options] of VARIANTS) {
		const r = simulate(sessions, options);
		const rate = ((100 * r.interventions) / r.scored).toFixed(1);
		console.log(
			`${name.padEnd(52)} nudges=${String(r.interventions).padStart(3)} (${rate.padStart(5)}%)  sessions-hit=${r.sessionsWithIntervention}/${r.sessionCount}  max-in-one=${r.maxInOneSession}  final-history-mean=${r.historyMean.toFixed(2)} (n=${r.historyCount})`,
		);
	}
	console.log();
}

// Deterministic micro-proof on a synthetic wordy session through the same
// real code: warmup at score 2, then a long run of score 8. OLD nags every
// degrading sample after the streak; SHIPPED nudges once and then either
// cools down or the slow upward adaptation settles the session.
console.log("=== synthetic wordy session (warmup 2x4, then 12 samples at score 8) ===");
for (const [name, options] of [
	["OLD", OLD],
	["SHIPPED", SHIPPED],
] as const) {
	let state = seedBaselineFromHistory(createChannelHistory(), options.warmupCount);
	let nudges = 0;
	let lastDegrading = false;
	const timeline: string[] = [];
	for (const score of [2, 2, 2, 2, ...Array(12).fill(8)]) {
		const update = updateBaseline(state, score, options);
		state = update.state;
		if (update.shouldIntervene) nudges++;
		lastDegrading = update.degrading;
		timeline.push(update.degrading ? (update.shouldIntervene ? "N" : "d") : ".");
	}
	console.log(
		`${name.padEnd(8)} nudges=${nudges}  still-degrading-at-end=${lastDegrading}  final-ewma=${(state.ewma ?? 0).toFixed(2)}  [${timeline.join("")}]  (. clean, d degrading, N nudge)`,
	);
}
