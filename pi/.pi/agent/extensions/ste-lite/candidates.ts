import type { Finding } from "./scorer.ts";

// Recurring-finding tracker. This is what lets the *approved-word list*
// itself improve over time, in addition to the baseline: dictionary swaps
// are deterministic and never change on their own, but style/hedge,
// style/puffery, and style/opener findings use fixed phrase lists that
// were curated once, up front, and will miss new fillers a model starts
// using six months from now.
//
// Rather than guessing at new words from raw text (noisy, and every
// scorer.ts rule this project ships already avoids heuristic auto-editing
// of meaning), this only tallies recurrences of findings the scorer
// *already* flagged as soft. When one keeps showing up across sessions,
// that is real, low-noise evidence a human can act on: `/ste-lite
// candidates` surfaces the count, `/ste-lite promote` turns it into a
// hard, auto-fixed dictionary entry. The list only grows when a person
// decides it should -- consistent with every rule in scorer.ts never
// rewriting a judgment call on its own.

// Findings whose excerpt is a stable, repeatable phrase (drawn from a
// fixed list in dictionary.ts) rather than arbitrary sentence content.
// length/sentence, verb/passive, and structure/prose-wall excerpts are
// content-derived and nearly always unique, so tallying them would just
// bloat the store with one-off keys.
export const TRACKED_RULES: readonly string[] = Object.freeze(["style/hedge", "style/puffery", "style/opener"]);

export interface CandidateEntry {
	rule: string;
	excerpt: string;
	count: number;
	lastSeenIso: string;
}

export type CandidateStore = Readonly<Record<string, CandidateEntry>>;

export function createCandidateStore(): CandidateStore {
	return {};
}

function candidateKey(rule: string, excerpt: string): string {
	return `${rule}::${excerpt.toLowerCase()}`;
}

/** Tallies TRACKED_RULES findings into the store. Pure: returns a new
 * store, never mutates the input. Findings for other rules are ignored. */
export function recordCandidates(store: CandidateStore, findings: readonly Finding[], nowIso: string): CandidateStore {
	let next: Record<string, CandidateEntry> = { ...store };
	for (const finding of findings) {
		if (!TRACKED_RULES.includes(finding.rule)) continue;
		const key = candidateKey(finding.rule, finding.excerpt);
		const existing = next[key];
		next[key] = {
			rule: finding.rule,
			excerpt: finding.excerpt.toLowerCase(),
			count: (existing?.count ?? 0) + 1,
			lastSeenIso: nowIso,
		};
	}
	return next;
}

/** Keeps the store bounded by dropping the least-frequent entries once it
 * grows past `maxEntries`. Ties are broken by recency (older drops first)
 * so the store cannot grow unboundedly across a long-lived install. */
export function pruneCandidates(store: CandidateStore, maxEntries: number): CandidateStore {
	const entries = Object.entries(store);
	if (entries.length <= maxEntries) return store;
	const kept = entries
		.sort(([, a], [, b]) => b.count - a.count || (a.lastSeenIso < b.lastSeenIso ? 1 : -1))
		.slice(0, maxEntries);
	return Object.fromEntries(kept);
}

export function topCandidates(store: CandidateStore, limit = 10): CandidateEntry[] {
	return Object.values(store)
		.sort((a, b) => b.count - a.count)
		.slice(0, limit);
}
