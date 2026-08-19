// Small curated ASD-STE100-ish word list. Kept intentionally short: every
// entry must have one unambiguous approved replacement so a swap can be
// applied automatically without touching meaning. Do not add words that
// only sometimes have a safe replacement (e.g. "leverage" as a noun vs a
// verb) -- those belong in scorer.ts as soft, report-only findings instead.
export const NOT_APPROVED_WORDS: Readonly<Record<string, string>> = Object.freeze({
	utilize: "use",
	utilizes: "uses",
	utilizing: "using",
	utilized: "used",
	facilitate: "help",
	facilitates: "helps",
	facilitated: "helped",
	commence: "start",
	commences: "starts",
	commenced: "started",
	terminate: "end",
	terminates: "ends",
	terminated: "ended",
	endeavor: "try",
	endeavour: "try",
	subsequently: "then",
	approximately: "about",
	numerous: "many",
	prior: "before",
	additional: "more",
	sufficient: "enough",
	obtain: "get",
	obtains: "gets",
	obtained: "got",
	purchase: "buy",
	purchased: "bought",
	regarding: "about",
	pertaining: "about",
});

// Filler openers coding agents tend to reach for. Matched only when they
// occur at the very start of the text (agent's own words, not quoted user
// text), so a legitimate mid-sentence use is never touched.
export const FILLER_OPENERS: readonly string[] = Object.freeze([
	"i'd be happy to",
	"i would be happy to",
	"great question",
	"certainly!",
	"certainly,",
	"sure thing",
	"absolutely!",
	"absolutely,",
	"let's dive in",
	"let's dive right in",
	"i'm happy to help",
	"of course!",
	"of course,",
	"great, i'll",
	"sounds good, i'll",
]) as readonly string[];

// Safe-to-delete subset of FILLER_OPENERS: only phrases that form a
// complete filler sentence on their own. Phrases such as "great, i'll" are
// deliberately excluded here (kept in FILLER_OPENERS for reporting only)
// because they are usually a prefix glued to real content in the same
// sentence ("Great, I'll refactor the auth module now.") -- deleting the
// prefix would leave a dangling fragment ("refactor the auth module now."
// reads fine, but "I would be happy to help." -> "help." does not).
// autofix() only ever removes a *whole* matching first sentence, never a
// partial prefix, so this list must contain complete clauses.
export const AUTOFIX_OPENERS: readonly string[] = Object.freeze([
	"i'd be happy to help",
	"i would be happy to help",
	"great question",
	"certainly",
	"sure thing",
	"absolutely",
	"let's dive in",
	"let's dive right in",
	"i'm happy to help",
	"of course",
]) as readonly string[];

// Hedging / throat-clearing phrases. Soft findings only -- deleting these
// safely requires judgment the fixer does not have, so they are reported
// but never auto-removed.
export const HEDGE_PHRASES: readonly string[] = Object.freeze([
	"it is important to note",
	"it's important to note",
	"it should be noted",
	"please note that",
	"as previously mentioned",
	"as mentioned earlier",
	"needless to say",
	"at the end of the day",
	"in order to",
	"due to the fact that",
	"for all intents and purposes",
]) as readonly string[];

// Marketing / puffery adjectives that read as filler in technical prose.
export const PUFFERY_WORDS: readonly string[] = Object.freeze([
	"seamless",
	"seamlessly",
	"robust",
	"powerful",
	"cutting-edge",
	"state-of-the-art",
	"revolutionary",
	"effortless",
	"effortlessly",
	"blazing",
	"elegant",
]) as readonly string[];
