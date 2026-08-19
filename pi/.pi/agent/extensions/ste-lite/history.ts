import type { BaselineState } from "./baseline.ts";

// Cross-session memory for the degradation baseline. baseline.ts alone
// resets to empty every session, so a returning session re-learns "how you
// normally write" from zero every single time -- the per-session warmup
// buys nothing across sessions. history.ts is the piece that actually
// improves over time: it accumulates a running mean per channel across
// every session that ever ran, and a new session seeds its warmup from
// that mean instead of starting blind. The more you use it, the fewer
// real samples a new session needs before it can tell degrading from
// normal-for-you.

export interface ChannelHistory {
	mean: number;
	count: number;
}

export interface HistoryState {
	replies: ChannelHistory;
	edits: ChannelHistory;
}

// Caps the effective weight of history so it stays responsive to how you
// write *now* rather than becoming nearly immovable after a year of use.
export const MAX_HISTORY_COUNT = 500;

export function createChannelHistory(): ChannelHistory {
	return { mean: 0, count: 0 };
}

export function createHistoryState(): HistoryState {
	return { replies: createChannelHistory(), edits: createChannelHistory() };
}

/** Folds one session's average score for a channel into that channel's
 * running history. Pure: returns a new ChannelHistory, never mutates the
 * input. A session with no scored samples (`sessionCount <= 0`) is a
 * no-op -- there is nothing to learn from a session that never wrote
 * enough prose to be scored.
 *
 * Contract callers must honor: `sessionMean`/`sessionCount` must be
 * computed only from samples the baseline did NOT flag as degrading. If a
 * degrading sample were folded in, a session (or a slow drift across many
 * sessions) that writes worse and worse would drag this mean up with it,
 * and a future session just as bad would no longer look degrading
 * relative to the now-inflated baseline. Feeding in only non-degrading
 * samples keeps history anchored to "how you write when you are not
 * degrading", so it stays a stable reference point no matter how long a
 * bad stretch runs. index.ts is the only caller and honors this. */
export function mergeChannelHistory(history: ChannelHistory, sessionMean: number, sessionCount: number): ChannelHistory {
	if (sessionCount <= 0 || !Number.isFinite(sessionMean)) return history;
	const priorCount = Math.min(history.count, MAX_HISTORY_COUNT);
	const combinedCount = priorCount + sessionCount;
	const mean = (history.mean * priorCount + sessionMean * sessionCount) / combinedCount;
	return { mean, count: Math.min(combinedCount, MAX_HISTORY_COUNT) };
}

/** Builds a session-starting BaselineState seeded from history. Only the
 * warmup buffer is pre-filled (`warmupCount - 1` historical samples), so a
 * returning session still needs exactly one real sample from *this*
 * session before it starts judging degradation -- history informs the
 * starting point, it never fully substitutes for the current session. A
 * channel with no history yet (`count === 0`) falls back to a normal cold
 * start. */
export function seedBaselineFromHistory(history: ChannelHistory, warmupCount: number): BaselineState {
	if (history.count <= 0 || warmupCount <= 0) {
		return { samples: [], ewma: null, streak: 0, armed: false };
	}
	const seedSamples = Math.max(0, warmupCount - 1);
	const samples = Array.from({ length: seedSamples }, () => history.mean);
	return { samples, ewma: samples.length > 0 ? history.mean : null, streak: 0, armed: false };
}
