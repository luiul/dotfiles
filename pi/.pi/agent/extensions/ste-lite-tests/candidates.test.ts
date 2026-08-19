import { describe, expect, it } from "vitest";
import { createCandidateStore, pruneCandidates, recordCandidates, topCandidates, TRACKED_RULES } from "../ste-lite/candidates";
import type { Finding } from "../ste-lite/scorer";

const NOW = "2026-08-20T00:00:00.000Z";

function finding(rule: string, excerpt: string): Finding {
	return { rule, severity: "soft", excerpt, index: 0 };
}

describe("recordCandidates", () => {
	it("tracks only the stable-phrase rules, ignoring content-derived findings", () => {
		const findings: Finding[] = [
			finding("style/puffery", "robust"),
			finding("length/sentence", "some unique long sentence excerpt"),
			finding("verb/passive", "was written"),
			finding("structure/prose-wall", "some unique wall excerpt"),
		];
		const store = recordCandidates(createCandidateStore(), findings, NOW);
		const keys = Object.values(store).map((c) => c.rule);
		expect(keys).toEqual(["style/puffery"]);
		expect(TRACKED_RULES).not.toContain("length/sentence");
		expect(TRACKED_RULES).not.toContain("verb/passive");
	});

	it("accumulates a count across repeated calls and normalizes excerpt case", () => {
		let store = createCandidateStore();
		store = recordCandidates(store, [finding("style/puffery", "Robust")], NOW);
		store = recordCandidates(store, [finding("style/puffery", "robust")], NOW);
		store = recordCandidates(store, [finding("style/hedge", "it is important to note")], NOW);

		const top = topCandidates(store, 10);
		expect(top[0]).toMatchObject({ rule: "style/puffery", excerpt: "robust", count: 2 });
		expect(top.some((c) => c.rule === "style/hedge" && c.count === 1)).toBe(true);
	});

	it("does not mutate the store passed in", () => {
		const store = createCandidateStore();
		recordCandidates(store, [finding("style/opener", "great question")], NOW);
		expect(Object.keys(store)).toHaveLength(0);
	});
});

describe("pruneCandidates", () => {
	it("keeps the store untouched when under the cap", () => {
		const store = recordCandidates(createCandidateStore(), [finding("style/puffery", "robust")], NOW);
		expect(pruneCandidates(store, 10)).toBe(store);
	});

	it("drops the least-frequent entries once over the cap", () => {
		let store = createCandidateStore();
		store = recordCandidates(store, [finding("style/puffery", "robust")], NOW);
		store = recordCandidates(store, [finding("style/puffery", "robust")], NOW);
		store = recordCandidates(store, [finding("style/puffery", "seamless")], NOW);

		const pruned = pruneCandidates(store, 1);
		const top = topCandidates(pruned, 10);
		expect(top).toHaveLength(1);
		expect(top[0].excerpt).toBe("robust");
	});
});
