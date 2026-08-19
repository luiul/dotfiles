import { describe, expect, it } from "vitest";
import { autofix, countWords, extractProseSpans, findViolations, scoreText, splitSentences, stripMarkdownCode } from "../ste-lite/scorer";

describe("stripMarkdownCode", () => {
	it("removes fenced code blocks, inline code, and raw URLs", () => {
		const text = "Read the docs at https://example.com/x then run `pi --reload` and check:\n```ts\nconst x = 1;\n```\nDone.";
		const stripped = stripMarkdownCode(text);
		expect(stripped).not.toContain("https://");
		expect(stripped).not.toContain("const x = 1");
		expect(stripped).not.toContain("pi --reload");
		expect(stripped).toContain("Read the docs");
		expect(stripped).toContain("Done.");
	});
});

describe("extractProseSpans", () => {
	it("treats markdown files as whole-file prose minus code fences", () => {
		const content = "# Title\n\nSome prose here.\n\n```js\nconst y = 2;\n```\n";
		const spans = extractProseSpans("README.md", content);
		expect(spans).toContain("Some prose here.");
		expect(spans).not.toContain("const y = 2");
	});

	it("extracts only comment bodies from a TypeScript file", () => {
		const content = [
			"// This utilizes a helper to obtain the result.",
			"const result = compute();",
			"/*",
			" * Block comment prose line.",
			" */",
			'const url = "https://example.com";',
		].join("\n");
		const spans = extractProseSpans("index.ts", content);
		expect(spans).toContain("utilizes a helper");
		expect(spans).toContain("Block comment prose line");
		expect(spans).not.toContain("compute()");
		expect(spans).not.toContain("https://example.com");
	});

	it("extracts only comment bodies from a Python file", () => {
		const content = ["# Utilize the cache to obtain speed.", "x = 1  # inline note about x"].join("\n");
		const spans = extractProseSpans("script.py", content);
		expect(spans).toContain("Utilize the cache");
		expect(spans).toContain("inline note about x");
	});

	it("returns empty prose for an unrecognized extension", () => {
		expect(extractProseSpans("data.bin", "utilize utilize utilize")).toBe("");
	});
});

describe("countWords / splitSentences", () => {
	it("counts words ignoring punctuation-only tokens", () => {
		expect(countWords("Hello, world! This is fine.")).toBe(5);
		expect(countWords("")).toBe(0);
		expect(countWords("---")).toBe(0);
	});

	it("splits on sentence boundaries", () => {
		const sentences = splitSentences("Short one. Another sentence here! And a question?");
		expect(sentences).toHaveLength(3);
	});
});

describe("findViolations", () => {
	it("flags a not-approved word as a hard finding with a suggestion", () => {
		const findings = findViolations("We should utilize the cache here.");
		const hit = findings.find((f) => f.rule === "dictionary/not-approved-word");
		expect(hit).toBeDefined();
		expect(hit?.severity).toBe("hard");
		expect(hit?.suggestion).toBe("use");
	});

	it("flags a sentence over 25 words as hard and over 20 as soft", () => {
		const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
		const hard = findViolations(`${words(26)}.`);
		const soft = findViolations(`${words(22)}.`);
		const clean = findViolations(`${words(10)}.`);
		expect(hard.some((f) => f.rule === "length/sentence" && f.severity === "hard")).toBe(true);
		expect(soft.some((f) => f.rule === "length/sentence" && f.severity === "soft")).toBe(true);
		expect(clean.some((f) => f.rule === "length/sentence")).toBe(false);
	});

	it("flags a hedge phrase and a filler opener", () => {
		const findings = findViolations("I'd be happy to help. It is important to note the deadline moved.");
		expect(findings.some((f) => f.rule === "style/opener")).toBe(true);
		expect(findings.some((f) => f.rule === "style/hedge")).toBe(true);
	});

	it("does not flag a filler opener phrase mid-sentence", () => {
		const findings = findViolations("She said great question is a good icebreaker for interviews today.");
		expect(findings.some((f) => f.rule === "style/opener")).toBe(false);
	});

	it("flags passive voice", () => {
		const findings = findViolations("The report was written by the team last night.");
		expect(findings.some((f) => f.rule === "verb/passive")).toBe(true);
	});

	it("does not flag an active sentence that merely ends in -ed", () => {
		const findings = findViolations("The team shipped the feature yesterday.");
		expect(findings.some((f) => f.rule === "verb/passive")).toBe(false);
	});

	it("flags a long, unstructured wall of text as a prose wall", () => {
		const sentence = "This is a moderately long sentence about the topic at hand and it keeps going on.";
		const wall = Array.from({ length: 10 }, () => sentence).join(" ");
		const findings = findViolations(wall);
		expect(findings.some((f) => f.rule === "structure/prose-wall")).toBe(true);
	});

	it("does not flag the same long text when it has bullets or headings", () => {
		const sentence = "This is a moderately long sentence about the topic at hand and it keeps going on.";
		const structured = `# Heading\n\n${Array.from({ length: 10 }, () => `- ${sentence}`).join("\n")}`;
		const findings = findViolations(structured);
		expect(findings.some((f) => f.rule === "structure/prose-wall")).toBe(false);
	});
});

describe("scoreText", () => {
	it("returns a zero score for empty text", () => {
		expect(scoreText("").score).toBe(0);
	});

	it("returns a higher score for denser violations, normalized per 100 words", () => {
		const clean = scoreText("The team shipped the feature yesterday and moved on to the next task.");
		const dirty = scoreText("We should utilize and facilitate this to commence the subsequent effort.");
		expect(dirty.score).toBeGreaterThan(clean.score);
	});
});

describe("autofix", () => {
	it("swaps a not-approved word for its approved replacement, preserving case", () => {
		const result = autofix("Utilize the cache, then utilize the index.");
		expect(result.text).toContain("Use the cache");
		expect(result.text).toContain("use the index");
		expect(result.changes.some((c) => c.rule === "dictionary/not-approved-word")).toBe(true);
	});

	it("strips a filler opener when enough content remains", () => {
		const result = autofix("I'd be happy to help. Here is the plan for the migration in three steps.");
		expect(result.text.toLowerCase().startsWith("i'd be happy to help")).toBe(false);
		expect(result.text).toContain("Here is the plan");
		expect(result.changes.some((c) => c.rule === "style/opener")).toBe(true);
	});

	it("refuses to strip a filler opener that would leave almost nothing behind", () => {
		const result = autofix("I'd be happy to help. Sure.");
		expect(result.text.toLowerCase()).toContain("i'd be happy to help");
		expect(result.changes.some((c) => c.rule === "style/opener")).toBe(false);
	});

	it("never touches hedge phrases or passive voice", () => {
		const result = autofix("It is important to note the report was written by the team.");
		expect(result.text).toContain("It is important to note");
		expect(result.text).toContain("was written");
		expect(result.changes).toHaveLength(0);
	});

	it("strips the whole filler sentence, never leaving a dangling fragment behind", () => {
		const result = autofix(
			"I would be happy to help. It is important to note that we should utilize the cache for this operation and the next one.",
		);
		expect(result.text.startsWith("help.")).toBe(false);
		expect(result.text.trim().startsWith("It is important to note")).toBe(true);
		expect(result.changes.find((c) => c.rule === "style/opener")?.before).toBe("I would be happy to help.");
	});

	it("does not strip a sentence that merely starts with a prefix-style opener but carries real content", () => {
		const result = autofix("Great, I'll refactor the auth module and add tests for it now.");
		expect(result.text).toContain("Great, I'll refactor the auth module");
		expect(result.changes.some((c) => c.rule === "style/opener")).toBe(false);
	});
});
