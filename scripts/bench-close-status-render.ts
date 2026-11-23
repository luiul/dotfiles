// Run: bun scripts/bench-close-status-render.ts [--output /tmp/close-render.json]
// Native Markdown controls isolate the cost of the display-only closing report.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { formatCloseReport } from "../pi/.pi/agent/extensions/close-status";

initTheme("dark");
const theme = getMarkdownTheme();
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = (values: number[]) => ({ medianUs: median(values), p95BatchMeanUs: [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] });
const results: any[] = [];
for (const long of [false, true]) {
	const prose = long ? Array.from({ length: 200 }, (_, i) => `Paragraph ${i}. This is a long native Markdown transcript with ordinary prose.`).join("\n\n") : "The review is ready.";
	const raw = `${prose}\n\nsafe_to_close: no\nclose_reason: Review and publication approval remain.\nnext_action: Review the diff.`;
	for (const width of [36, 80, 120]) {
		for (const cached of [false, true]) {
			const samples: Record<string, number[]> = { bare: [], candidate: [] };
			const component = (candidate: boolean) => new Markdown(raw, 0, 0, theme, undefined, candidate ? { transform: text => formatCloseReport(text) } : undefined);
			const hosts = { bare: component(false), candidate: component(true) };
			for (const host of Object.values(hosts)) host.render(width);
			const iterations = cached ? 1000 : long ? 5 : 100;
			for (let batch = 0; batch < 9; batch++) {
				for (const name of batch % 2 ? ["candidate", "bare"] : ["bare", "candidate"]) {
					const start = performance.now();
					for (let i = 0; i < iterations; i++) (cached ? hosts[name as keyof typeof hosts] : component(name === "candidate")).render(width);
					samples[name].push((performance.now() - start) * 1000 / iterations);
				}
			}
			for (const host of Object.values(hosts)) assert(host.render(width).every(row => visibleWidth(row) <= width));
			const bare = summary(samples.bare), candidate = summary(samples.candidate);
			results.push({ long, characters: raw.length, width, cached, iterations, bare, candidate, deltaUs: candidate.medianUs - bare.medianUs });
		}
	}
}
const report = {
	runtime: `Bun ${Bun.version}`,
	benchmark: "Native Markdown, alternating nine warmed batches. Bare uses raw fields; candidate uses the display-only transformer. No Pi host or I/O in measurements.",
	units: "microseconds per render; p95 across batch means, not individual event latency",
	sourceSha256: createHash("sha256").update(readFileSync(new URL("../pi/.pi/agent/extensions/close-status.ts", import.meta.url))).digest("hex"),
	results,
};
const index = process.argv.indexOf("--output");
if (index >= 0) writeFileSync(process.argv[index + 1], JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
