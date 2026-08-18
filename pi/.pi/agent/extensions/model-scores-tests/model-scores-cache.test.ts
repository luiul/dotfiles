import { describe, expect, it } from "vitest";
import { buildCacheSnapshot, isCacheStale, markSourceFailure, validateCache } from "../model-scores/cache";
import type { ModelLike } from "../model-scores/core";

function model(id: string, overrides: Partial<ModelLike> = {}): ModelLike {
	return {
		id,
		provider: "amazon-bedrock",
		name: id,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	};
}

describe("model scores cache", () => {
	it("reconciles exact inventory identities and keeps unknowns as null", () => {
		const cache = buildCacheSnapshot(
			[{ model: model("known") }, { model: model("unknown", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) }],
			{ scope: "scoped", now: "2026-08-18T00:00:00.000Z" },
		);
		const unknown = cache.models['["amazon-bedrock","unknown"]'];
		expect(cache.inventory.count).toBe(2);
		expect(unknown.cost).toBeNull();
		expect(unknown.readiness).toBe("unknown");
		expect(validateCache(cache)).toBe(true);
	});

	it("preserves the last known good cost when current metadata loses it", () => {
		const previous = buildCacheSnapshot([{ model: model("known") }], { scope: "scoped", now: "2026-08-17T00:00:00.000Z" });
		const current = buildCacheSnapshot(
			[{ model: model("known", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) }],
			{ scope: "scoped", previous, now: "2026-08-18T00:00:00.000Z" },
		);
		expect(current.models['["amazon-bedrock","known"]'].cost).toEqual(previous.models['["amazon-bedrock","known"]'].cost);
	});

	it("marks source failures stale without deleting the last successful state", () => {
		const cache = buildCacheSnapshot([{ model: model("known") }], { scope: "scoped" });
		const failed = markSourceFailure(cache, "bedrockPricing", new Error("temporary failure"));
		expect(failed.sources.bedrockPricing.state).toBe("stale");
		expect(failed.sources.bedrockPricing.lastSuccessAt).not.toBeNull();
	});

	it("detects stale snapshots", () => {
		const cache = buildCacheSnapshot([{ model: model("known") }], { scope: "scoped", now: "2026-08-16T00:00:00.000Z" });
		expect(isCacheStale(cache, Date.parse("2026-08-18T00:00:01.000Z"))).toBe(true);
	});
});
