import { AUTOFIX_OPENERS, FILLER_OPENERS, HEDGE_PHRASES, NOT_APPROVED_WORDS, PUFFERY_WORDS } from "./dictionary.ts";

export type Severity = "hard" | "soft";

export interface Finding {
	rule: string;
	severity: Severity;
	excerpt: string;
	suggestion?: string;
	index: number;
}

export interface ScoreResult {
	score: number;
	wordCount: number;
	findings: Finding[];
}

export interface FixChange {
	rule: string;
	before: string;
	after: string;
}

export interface FixResult {
	text: string;
	changes: FixChange[];
}

const HARD_WEIGHT = 3;
const SOFT_WEIGHT = 1;
const SENTENCE_SOFT_WORDS = 20;
const SENTENCE_HARD_WORDS = 25;
const PROSE_WALL_MIN_WORDS = 150;
const PROSE_WALL_MIN_SENTENCES = 8;

const PASSIVE_PARTICIPLE_IRREGULARS =
	"done|made|seen|written|shown|given|taken|known|found|said|put|set|held|told|sent|kept|built|spent|left|meant|felt|brought|thought|bought|taught|caught|sold|read|run|gone|begun|chosen|drawn|driven|eaten|fallen|forgotten|grown|hidden|ridden|risen|spoken|stolen|thrown|worn|won";
const PASSIVE_VOICE_RE = new RegExp(
	`\\b(?:is|are|was|were|be|been|being)\\s+(?:\\w+(?:ed|en)\\b|(?:${PASSIVE_PARTICIPLE_IRREGULARS})\\b)`,
	"gi",
);

function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Removes fenced code blocks, inline code spans, and raw URLs from markdown-ish
 * text so scoring only ever sees prose. Never mutates the caller's string. */
export function stripMarkdownCode(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/~~~[\s\S]*?~~~/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.replace(/https?:\/\/\S+/g, " ");
}

const LINE_COMMENT_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
	ts: "//",
	tsx: "//",
	js: "//",
	jsx: "//",
	mjs: "//",
	cjs: "//",
	go: "//",
	rs: "//",
	java: "//",
	kt: "//",
	swift: "//",
	c: "//",
	cc: "//",
	cpp: "//",
	h: "//",
	hpp: "//",
	py: "#",
	rb: "#",
	sh: "#",
	bash: "#",
	zsh: "#",
	yaml: "#",
	yml: "#",
	toml: "#",
});

const BLOCK_COMMENT_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "rs", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp"]);
const WHOLE_FILE_PROSE_EXTENSIONS = new Set(["md", "markdown", "mdx", "txt"]);

function extensionOf(filePath: string): string {
	const match = /\.([a-zA-Z0-9]+)$/.exec(filePath);
	return match ? match[1].toLowerCase() : "";
}

/** Extracts only the prose spans a file's content actually carries: whole
 * content (minus code fences) for markdown/text files, or comment bodies
 * only for source files. Unknown extensions score as empty (no false
 * positives on code, binaries, or config formats we do not recognize). */
export function extractProseSpans(filePath: string, content: string): string {
	const ext = extensionOf(filePath);
	if (WHOLE_FILE_PROSE_EXTENSIONS.has(ext)) return stripMarkdownCode(content);
	if (!(ext in LINE_COMMENT_EXTENSIONS)) return "";

	const lineToken = LINE_COMMENT_EXTENSIONS[ext];
	const spans: string[] = [];

	if (BLOCK_COMMENT_EXTENSIONS.has(ext)) {
		for (const block of content.matchAll(/\/\*([\s\S]*?)\*\//g)) {
			spans.push(block[1].replace(/^\s*\*/gm, ""));
		}
	}

	const lineTokenEscaped = escapeRegExp(lineToken);
	const lineCommentRe = new RegExp(`(?:^|[^:])${lineTokenEscaped}(.*)$`, "gm");
	for (const line of content.matchAll(lineCommentRe)) {
		spans.push(line[1]);
	}

	return spans.join("\n");
}

export function countWords(text: string): number {
	const words = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g);
	return words ? words.length : 0;
}

/** Splits into sentences on ./!/? boundaries. Not abbreviation-aware; that
 * is an acceptable trade for a fast, dependency-free heuristic. */
export function splitSentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+(?=[A-Z0-9"'`])|\n{2,}/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

function findAll(text: string, phrase: string): number[] {
	const indexes: number[] = [];
	const re = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "gi");
	for (const m of text.matchAll(re)) indexes.push(m.index ?? 0);
	return indexes;
}

export function findViolations(text: string): Finding[] {
	const findings: Finding[] = [];
	const trimmed = text.trim();

	// dictionary/not-approved-word
	for (const [word, suggestion] of Object.entries(NOT_APPROVED_WORDS)) {
		const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, "gi");
		for (const m of text.matchAll(re)) {
			findings.push({
				rule: "dictionary/not-approved-word",
				severity: "hard",
				excerpt: m[0],
				suggestion,
				index: m.index ?? 0,
			});
		}
	}

	// length/sentence
	let cursor = 0;
	for (const sentence of splitSentences(text)) {
		const wordCount = countWords(sentence);
		const index = text.indexOf(sentence, cursor);
		cursor = index >= 0 ? index + sentence.length : cursor;
		if (wordCount > SENTENCE_HARD_WORDS) {
			findings.push({
				rule: "length/sentence",
				severity: "hard",
				excerpt: sentence.slice(0, 60),
				index: index >= 0 ? index : 0,
			});
		} else if (wordCount > SENTENCE_SOFT_WORDS) {
			findings.push({
				rule: "length/sentence",
				severity: "soft",
				excerpt: sentence.slice(0, 60),
				index: index >= 0 ? index : 0,
			});
		}
	}

	// style/hedge
	for (const phrase of HEDGE_PHRASES) {
		for (const index of findAll(text, phrase)) {
			findings.push({ rule: "style/hedge", severity: "soft", excerpt: phrase, index });
		}
	}

	// style/puffery
	for (const word of PUFFERY_WORDS) {
		for (const index of findAll(text, word)) {
			findings.push({ rule: "style/puffery", severity: "soft", excerpt: word, index });
		}
	}

	// style/opener (start of text only)
	const lowerTrimmed = trimmed.toLowerCase();
	for (const opener of FILLER_OPENERS) {
		if (lowerTrimmed.startsWith(opener)) {
			findings.push({ rule: "style/opener", severity: "soft", excerpt: opener, index: 0 });
			break;
		}
	}

	// verb/passive
	for (const m of text.matchAll(PASSIVE_VOICE_RE)) {
		findings.push({ rule: "verb/passive", severity: "soft", excerpt: m[0], index: m.index ?? 0 });
	}

	// structure/prose-wall
	const sentences = splitSentences(text);
	const hasStructure = /(^|\n)\s*([-*]|\d+\.)\s/m.test(text) || /\n#{1,6}\s/.test(text);
	if (!hasStructure && countWords(text) >= PROSE_WALL_MIN_WORDS && sentences.length >= PROSE_WALL_MIN_SENTENCES) {
		findings.push({ rule: "structure/prose-wall", severity: "soft", excerpt: sentences[0]?.slice(0, 60) ?? "", index: 0 });
	}

	return findings;
}

export function scoreText(text: string): ScoreResult {
	const wordCount = countWords(text);
	const findings = findViolations(text);
	if (wordCount === 0) return { score: 0, wordCount: 0, findings };

	const hardCount = findings.filter((f) => f.severity === "hard").length;
	const softCount = findings.filter((f) => f.severity === "soft").length;
	const weighted = hardCount * HARD_WEIGHT + softCount * SOFT_WEIGHT;
	const score = weighted / (wordCount / 100);
	return { score, wordCount, findings };
}

function preserveCase(source: string, replacement: string): string {
	if (source === source.toUpperCase() && source !== source.toLowerCase()) return replacement.toUpperCase();
	if (source[0] === source[0]?.toUpperCase() && source[0] !== source[0]?.toLowerCase()) {
		return replacement[0].toUpperCase() + replacement.slice(1);
	}
	return replacement;
}

const MIN_WORDS_AFTER_OPENER_STRIP = 4;

/** Applies only meaning-preserving mechanical fixes: dictionary word swaps
 * (word-for-word, never changes sentence count or meaning) and deleting a
 * known filler opener when it forms the *entire* first sentence. Never
 * strips a mere prefix of the first sentence -- that risks leaving a
 * dangling fragment ("I would be happy to help." -> "help.") the way a
 * partial-match strip would. Refuses the strip entirely if it would leave
 * fewer than a handful of words behind: if the whole reply was filler,
 * that is a judgment call for the author, not a fixer. Never touches
 * hedges, passive voice, or puffery: those need a human or a model
 * rewrite, not a regex. */
export function autofix(text: string): FixResult {
	const changes: FixChange[] = [];
	let result = text;

	for (const [word, suggestion] of Object.entries(NOT_APPROVED_WORDS)) {
		const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, "gi");
		result = result.replace(re, (match) => {
			const replaced = preserveCase(match, suggestion);
			changes.push({ rule: "dictionary/not-approved-word", before: match, after: replaced });
			return replaced;
		});
	}

	const leadingWhitespaceMatch = /^\s*/.exec(result);
	const leadingWhitespace = leadingWhitespaceMatch ? leadingWhitespaceMatch[0] : "";
	const body = result.slice(leadingWhitespace.length);
	const [firstSentence] = splitSentences(body);
	if (firstSentence) {
		const normalizedFirst = firstSentence
			.toLowerCase()
			.replace(/[!.,]+$/, "")
			.trim();
		const isPureFillerSentence = AUTOFIX_OPENERS.some((opener) => normalizedFirst === opener);
		if (isPureFillerSentence) {
			const afterFirstSentence = body.slice(firstSentence.length).replace(/^\s+/, "");
			if (countWords(afterFirstSentence) >= MIN_WORDS_AFTER_OPENER_STRIP) {
				changes.push({ rule: "style/opener", before: firstSentence, after: "" });
				result = leadingWhitespace + afterFirstSentence;
			}
		}
	}

	return { text: result, changes };
}
