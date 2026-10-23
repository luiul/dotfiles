// Unit tests for the split extension's update notices (split-updates.ts):
// the pi version check's compare and parsing, notice builders, the doc block
// renderer, and the response-doc append idempotency.
//
// Contracts pinned here:
// - isNewerVersion mirrors pi's isNewerPackageVersion semantics: X.Y.Z
//   numeric compare, release > prerelease of the same core, string-inequality
//   fallback for anything unparsable.
// - parseLatestRelease accepts pi's payload shape only: object with a
//   non-empty string version; note kept when non-empty, dropped otherwise;
//   everything else is undefined ("no update", never a crash).
// - Builders produce pi's own wording (titles "Update Available" /
//   "Package Updates Available", `pi update` / `pi update --extensions`,
//   changelog link) with the release note as plain text, capped to 2 lines
//   and 160 chars.
// - buildChangelogNotice is the condensed post-update notice: undefined for
//   a missing marker (first install), an equal marker, or a NEWER marker
//   (downgrade); for a newer running version it is one body line naming the
//   version and linking https://pi.dev/changelog (the full entry, 56 lines
//   for 1.4.0, is too big for the panel or the doc — user decision
//   2026-10-24). The fake fixture includes it first and the footer status
//   leads with "updated to X.Y.Z".
// - UpdateNoticeBlock renders pi's block shape (blank, warning stroke, bold
//   title, wrapped body with one leading pad column, warning stroke), never
//   exceeds the width budget, and renders nothing until a theme resolves.
// - appendUpdateNoticesToDoc is idempotent (no duplicate blocks) and removes
//   blocks when the notices reset — the live-append and rebuild paths must
//   not double-add.
//
// Run: bun scripts/test-split-updates.ts
import { initTheme, VERSION } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

// UpdateNoticeBlock renders through a theme; a bare bun run must install one
// first (pi's TUI normally does this at startup).
initTheme("system");

const {
	isNewerVersion,
	parseLatestRelease,
	buildPiUpdateNotice,
	buildPackageUpdatesNotice,
	buildSkillConflictsNotice,
	buildChangelogNotice,
	noticeBodyText,
	noticesStatusText,
	fakeUpdateNotices,
	setUpdateNotices,
	getActiveNotices,
	resetUpdateNotices,
	PI_UPDATE_ID,
	PACKAGE_UPDATES_ID,
	SKILL_CONFLICTS_ID,
	CHANGELOG_WHATSNEW_ID,
	UpdateNoticeBlock,
} = await import("../pi/.pi/agent/extensions/split/split-updates.ts");
const {
	appendUpdateNoticesToDoc,
	setResponseTheme,
	getResponseDoc,
	resetResponseState,
} = await import("../pi/.pi/agent/extensions/split/split-response.ts");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
	if (cond) {
		pass++;
		console.log(`  ok  ${name}`);
	} else {
		fail++;
		console.log(
			`FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`,
		);
	}
}

/** Pass-through mock theme with bold: rows come back plain for assertions. */
const theme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
} as never;
setResponseTheme(theme); // UpdateNoticeBlock resolves the doc theme lazily

// ─── isNewerVersion ──────────────────────────────────────────────────────────

check("newer patch", isNewerVersion("1.3.1", "1.3.0"));
check("newer minor", isNewerVersion("1.4.0", "1.3.9"));
check("newer major", isNewerVersion("2.0.0", "1.99.99"));
check("older is not newer", !isNewerVersion("1.2.9", "1.3.0"));
check("equal is not newer", !isNewerVersion("1.3.0", "1.3.0"));
check(
	"prerelease of same core is NOT newer than the release",
	!isNewerVersion("1.3.1-beta.1", "1.3.1"),
);
check(
	"release IS newer than a prerelease of the same core",
	isNewerVersion("1.3.1", "1.3.1-beta.1"),
);
check(
	"higher prerelease identifier is newer",
	isNewerVersion("1.3.1-beta.2", "1.3.1-beta.1"),
);
check("build metadata ignored", !isNewerVersion("1.3.0+build.7", "1.3.0"));
check(
	"unparsable falls back to string inequality (pi semantics)",
	isNewerVersion("dev", "1.3.0"),
);
check(
	"unparsable equal strings are not newer",
	!isNewerVersion("dev", "dev"),
);
check("current pi VERSION parses", /^\d+\.\d+\.\d+$/.test(VERSION));

// ─── parseLatestRelease ──────────────────────────────────────────────────────

check("valid payload", parseLatestRelease({ version: "1.4.0" })?.version === "1.4.0");
check(
	"note kept when non-empty",
	parseLatestRelease({ version: "1.4.0", note: "  hello  " })?.note === "hello",
);
check(
	"whitespace-only note dropped",
	parseLatestRelease({ version: "1.4.0", note: "   " })?.note === undefined,
);
check("missing version", parseLatestRelease({ note: "x" }) === undefined);
check("empty version", parseLatestRelease({ version: "" }) === undefined);
check("non-string version", parseLatestRelease({ version: 42 }) === undefined);
check("null", parseLatestRelease(null) === undefined);
check("array", parseLatestRelease([1]) === undefined);
check("string", parseLatestRelease("1.4.0") === undefined);
check("version trimmed", parseLatestRelease({ version: " 1.4.0 " })?.version === "1.4.0");

// ─── builders ────────────────────────────────────────────────────────────────

const piNotice = buildPiUpdateNotice({ version: "9.9.9", note: "line one\n\nline two\nline three" });
check("pi notice id", piNotice.id === PI_UPDATE_ID && PI_UPDATE_ID === "update:pi");
check("pi notice title (pi's own wording)", piNotice.title === "Update Available");
const piText = noticeBodyText(piNotice);
check("pi notice instruction names the version", piText.includes("New version 9.9.9 is available"));
check("pi notice instruction names the command", piText.includes("pi update"));
check("pi notice links the changelog", piText.includes("Changelog: https://pi.dev/changelog"));
check(
	"note capped to 2 non-empty lines, plain text",
	piText.includes("line one") && piText.includes("line two") && !piText.includes("line three"),
);
const longNote = buildPiUpdateNotice({ version: "9.9.9", note: "x".repeat(500) });
check(
	"long note line truncated at 160 chars",
	noticeBodyText(longNote).split("\n")[2].length <= 160,
);
const noNote = buildPiUpdateNotice({ version: "9.9.9" });
check(
	"no note means exactly 2 body lines",
	noNote.body.length === 2,
);

const pkgNotice = buildPackageUpdatesNotice(["pkg-a", "pkg-b"]);
check("pkg notice id", pkgNotice.id === PACKAGE_UPDATES_ID && PACKAGE_UPDATES_ID === "update:packages");
check("pkg notice title (pi's own wording)", pkgNotice.title === "Package Updates Available");
const pkgText = noticeBodyText(pkgNotice);
check("pkg notice command is --extensions", pkgText.includes("pi update --extensions"));
check("pkg notice lists packages", pkgText.includes("- pkg-a") && pkgText.includes("- pkg-b"));
check("empty package list: header only, no package rows (collectStartupNotices guards the >0 case)",
	buildPackageUpdatesNotice([]).body.length === 2 &&
		!noticeBodyText(buildPackageUpdatesNotice([])).includes("- "));

const fake = fakeUpdateNotices();
check("fake fixture: four notices", fake.length === 4);
check(
	"fake fixture: changelog first",
	fake[0].id === CHANGELOG_WHATSNEW_ID && CHANGELOG_WHATSNEW_ID === "changelog:whatsnew",
);
check("fake fixture: skill conflicts second", fake[1].id === SKILL_CONFLICTS_ID && SKILL_CONFLICTS_ID === "conflicts:skills");
check("fake fixture: pi version marker 999.0.0", noticeBodyText(fake[2]).includes("999.0.0"));
check("fake fixture: package names", noticeBodyText(fake[3]).includes("fake-package-a"));

// ─── skill conflicts notice ──────────────────────────────────────────────────

const conflictNotice = buildSkillConflictsNotice([
	{ name: "playwriter", winnerPath: "~/.pi/agent/skills/playwriter/SKILL.md", loserPath: "~/.agents/skills/playwriter/SKILL.md" },
]);
check("conflicts: title", conflictNotice.title === "Skill conflicts");
const conflictText = noticeBodyText(conflictNotice);
check("conflicts: warning header per collision", conflictText.includes('"playwriter" collision:'));
check("conflicts: winner line with ✓", conflictText.includes("✓ ~/.pi/agent/skills/playwriter/SKILL.md"));
check("conflicts: loser line with ✗ and (skipped)", conflictText.includes("✗ ~/.agents/skills/playwriter/SKILL.md (skipped)"));
check("conflicts: one collision is 3 lines", conflictNotice.body.length === 3);
const twoConflicts = buildSkillConflictsNotice([
	{ name: "a", winnerPath: "/w/a", loserPath: "/l/a" },
	{ name: "b", winnerPath: "/w/b", loserPath: "/l/b" },
]);
check("conflicts: two collisions are 6 lines", twoConflicts.body.length === 6);

// ─── changelog notice ──────────────────────────────────────────────────────────

check(
	"changelog: no notice without a marker (first install)",
	buildChangelogNotice(undefined, "1.4.0") === undefined,
);
check(
	"changelog: no notice when the marker equals the running version",
	buildChangelogNotice("1.4.0", "1.4.0") === undefined,
);
check(
	"changelog: no notice on a downgrade (marker newer than running)",
	buildChangelogNotice("1.4.1", "1.4.0") === undefined,
);
const changelogNotice = buildChangelogNotice("1.3.0", "1.4.0");
check(
	"changelog: id",
	changelogNotice!.id === CHANGELOG_WHATSNEW_ID,
);
check(
	"changelog: title names the running version",
	changelogNotice!.title === "What's New (1.4.0)",
);
check("changelog: one body line", changelogNotice!.body.length === 1);
const changelogText = noticeBodyText(changelogNotice!);
check(
	"changelog: says what you are on now",
	changelogText.includes("Updated to v1.4.0. Full changelog: https://pi.dev/changelog"),
);

// ─── footer status text ──────────────────────────────────────────────────────

check("status: undefined when empty", noticesStatusText([]) === undefined);
check(
	"status: fake fixture sums all four",
	noticesStatusText(fake) ===
		"updated to 999.0.0 · pi 999.0.0 available · 2 package updates · 1 skill conflict",
);
check(
	"status: changelog alone",
	noticesStatusText([changelogNotice!]) === "updated to 1.4.0",
);
check(
	"status: plural conflicts",
	noticesStatusText([twoConflicts]) === "2 skill conflicts",
);
check(
	"status: pi update alone",
	noticesStatusText([buildPiUpdateNotice({ version: "1.4.0" })]) === "pi 1.4.0 available",
);

// ─── UpdateNoticeBlock render ────────────────────────────────────────────────

const W = 70;
const block = new UpdateNoticeBlock(() => theme as never, piNotice);
const rows = block.render(W);
check("block: blank + stroke + title first", rows[0] === "" && rows[1] === "─".repeat(W) && rows[2] === "Update Available");
check("block: stroke closes", rows[rows.length - 1] === "─".repeat(W));
check(
	"block: body wrapped inside the width budget",
	rows.slice(3, -1).every((r) => visibleWidth(r) <= W),
);
check(
	"block: body lines carry one leading pad column",
	rows.slice(3, -1).every((r) => r.startsWith(" ")),
);
const narrow = new UpdateNoticeBlock(() => theme as never, piNotice).render(20);
check(
	"block: wraps at narrow widths without overflow",
	narrow.every((r) => visibleWidth(r) <= 20),
);
const ultra = new UpdateNoticeBlock(() => theme as never, piNotice).render(8);
check(
	"block: never overflows even below the 10-col clamp",
	ultra.every((r) => visibleWidth(r) <= 8),
);
check(
	"block: no theme resolved yet renders nothing (RowDivider pattern)",
	new UpdateNoticeBlock(() => null, piNotice).render(W).length === 0,
);
check("block: noticeId exposed for idempotent re-append", block.noticeId === "update:pi");

// ─── response-doc append (idempotency + reset) ───────────────────────────────

resetResponseState();
setUpdateNotices([piNotice, pkgNotice]);
appendUpdateNoticesToDoc();
appendUpdateNoticesToDoc(); // live append after a rebuild path must not duplicate
const doc = getResponseDoc();
const blocks = (doc.children as any[]).filter((c) => c instanceof UpdateNoticeBlock);
check("doc: exactly one block per notice after double append", blocks.length === 2);
check("doc: blocks sit at the top", doc.children[0] instanceof UpdateNoticeBlock && doc.children[1] instanceof UpdateNoticeBlock);
check(
	"doc: block order follows notice order",
	doc.children[0].noticeId === "update:pi" && doc.children[1].noticeId === "update:packages",
);
resetUpdateNotices();
appendUpdateNoticesToDoc();
check(
	"doc: reset removes the blocks",
	!(getResponseDoc().children as any[]).some((c) => c instanceof UpdateNoticeBlock),
);
check("state: getActiveNotices reflects set/reset", getActiveNotices().length === 0);

// ─── teardown ───────────────────────────────────────────────────────────────

resetResponseState();
check("teardown: doc cleared", (getResponseDoc().children as any[]).length === 0);
check("teardown: ResponseDoc is still the module singleton Container", getResponseDoc() instanceof Container);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
