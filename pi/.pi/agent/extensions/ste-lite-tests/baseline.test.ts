import { describe, expect, it } from "vitest";
import {
	createBaselineState,
	DEFAULT_DEGRADING_ALPHA,
	DEFAULT_STREAK_THRESHOLD,
	DEFAULT_WARMUP_COUNT,
	updateBaseline,
} from "../ste-lite/baseline";

describe("baseline warmup", () => {
	it("never intervenes during warmup regardless of score", () => {
		let state = createBaselineState();
		for (let i = 0; i < DEFAULT_WARMUP_COUNT; i++) {
			const update = updateBaseline(state, 50);
			expect(update.degrading).toBe(false);
			expect(update.shouldIntervene).toBe(false);
			state = update.state;
		}
		expect(state.ewma).toBeCloseTo(50);
	});
});

describe("baseline degrade detection", () => {
	function warmup(score = 2): ReturnType<typeof createBaselineState> {
		let state = createBaselineState();
		for (let i = 0; i < DEFAULT_WARMUP_COUNT; i++) {
			state = updateBaseline(state, score).state;
		}
		return state;
	}

	it("does not flag a single spike as degrading-enough to intervene", () => {
		const warm = warmup(2);
		const spike = updateBaseline(warm, 20);
		expect(spike.degrading).toBe(true);
		expect(spike.shouldIntervene).toBe(false);
	});

	it("intervenes once the degrading streak reaches the threshold", () => {
		let state = warmup(2);
		let lastUpdate = updateBaseline(state, 20);
		state = lastUpdate.state;
		for (let i = 1; i < DEFAULT_STREAK_THRESHOLD; i++) {
			lastUpdate = updateBaseline(state, 20);
			state = lastUpdate.state;
		}
		expect(lastUpdate.shouldIntervene).toBe(true);
		expect(state.armed).toBe(true);
	});

	it("adapts upward slowly on degrading samples without immediately normalizing them", () => {
		let state = warmup(2);
		const before = state.ewma ?? 0;
		const update = updateBaseline(state, 30);
		state = update.state;
		expect(update.degrading).toBe(true);
		expect(state.ewma).toBeGreaterThan(before);
		expect(state.ewma).toBeCloseTo(before + DEFAULT_DEGRADING_ALPHA * (30 - before));
	});

	it("re-arms only after a clean sample and caps interventions per session", () => {
		let state = warmup(2);
		let update = updateBaseline(state, 20, { maxInterventions: 2, streakThreshold: 2 });
		state = update.state;
		update = updateBaseline(state, 20, { maxInterventions: 2, streakThreshold: 2 });
		state = update.state;
		expect(update.shouldIntervene).toBe(true);
		update = updateBaseline(state, 20, { maxInterventions: 2, streakThreshold: 2 });
		state = update.state;
		expect(update.shouldIntervene).toBe(false);
		update = updateBaseline(state, 2, { maxInterventions: 2, streakThreshold: 2 });
		state = update.state;
		expect(update.recovered).toBe(true);
		update = updateBaseline(state, 20, { maxInterventions: 2, streakThreshold: 2 });
		state = update.state;
		update = updateBaseline(state, 20, { maxInterventions: 2, streakThreshold: 2 });
		state = update.state;
		expect(update.shouldIntervene).toBe(true);
		update = updateBaseline(state, 2, { maxInterventions: 2, streakThreshold: 2 });
		state = update.state;
		update = updateBaseline(state, 20, { maxInterventions: 2, streakThreshold: 2 });
		state = update.state;
		update = updateBaseline(state, 20, { maxInterventions: 2, streakThreshold: 2 });
		expect(update.shouldIntervene).toBe(false);
		expect(update.state.interventionCount).toBe(2);
	});

	it("resets the streak and reports recovery after an armed streak", () => {
		let state = warmup(2);
		state = updateBaseline(state, 20, { streakThreshold: 2 }).state;
		state = updateBaseline(state, 20, { streakThreshold: 2 }).state;
		expect(state.armed).toBe(true);

		const recovery = updateBaseline(state, 2, { streakThreshold: 2 });
		expect(recovery.recovered).toBe(true);
		expect(recovery.state.armed).toBe(false);
		expect(recovery.state.streak).toBe(0);
	});

	it("does not report recovery when the session was never armed", () => {
		const warm = warmup(2);
		const clean = updateBaseline(warm, 2);
		expect(clean.recovered).toBe(false);
	});
});
