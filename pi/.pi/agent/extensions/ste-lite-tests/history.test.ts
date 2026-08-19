import { describe, expect, it } from "vitest";
import { createChannelHistory, mergeChannelHistory, seedBaselineFromHistory } from "../ste-lite/history";

describe("mergeChannelHistory", () => {
	it("adopts the session mean outright when there is no prior history", () => {
		const merged = mergeChannelHistory(createChannelHistory(), 10, 5);
		expect(merged).toEqual({ mean: 10, count: 5 });
	});

	it("is a count-weighted average of prior history and the new session", () => {
		const history = { mean: 4, count: 20 };
		const merged = mergeChannelHistory(history, 20, 5);
		// (4*20 + 20*5) / 25 = 7.2
		expect(merged.mean).toBeCloseTo(7.2);
		expect(merged.count).toBe(25);
	});

	it("is a no-op for a session that produced no scored samples", () => {
		const history = { mean: 4, count: 20 };
		expect(mergeChannelHistory(history, 99, 0)).toEqual(history);
	});

	it("caps the effective weight so history stays responsive over a long install", () => {
		const history = { mean: 2, count: 10_000 };
		const merged = mergeChannelHistory(history, 50, 10);
		expect(merged.count).toBeLessThanOrEqual(500);
		// even a huge stale count cannot fully drown out ten fresh, very different samples
		expect(merged.mean).toBeGreaterThan(2);
	});
});

describe("seedBaselineFromHistory", () => {
	it("falls back to a cold start when there is no history yet", () => {
		const seeded = seedBaselineFromHistory(createChannelHistory(), 4);
		expect(seeded).toEqual({ samples: [], ewma: null, streak: 0, armed: false });
	});

	it("pre-fills all but one warmup slot from the historical mean", () => {
		const seeded = seedBaselineFromHistory({ mean: 6, count: 50 }, 4);
		expect(seeded.samples).toHaveLength(3);
		expect(seeded.samples.every((s) => s === 6)).toBe(true);
		expect(seeded.ewma).toBe(6);
		expect(seeded.armed).toBe(false);
	});

	it("still requires at least one real sample from the current session to leave warmup", () => {
		const seeded = seedBaselineFromHistory({ mean: 6, count: 50 }, 1);
		expect(seeded.samples).toHaveLength(0);
	});
});
