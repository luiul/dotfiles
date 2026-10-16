// Unit tests for the split extension's File Changes panel row renderer
// (split-files.ts: buildFilesRows + wrapPathSegments).
//
// Pins the legibility contract from the 2026-10-16 live report: rows must
// never overflow the section width (no `untrac`-style mid-word clipping at
// the panel edge), long paths wrap at "/" boundaries in wide chunks (never
// 8-character fragments), the kind word keeps its trailing space
// (`modified path`, not `modifiedpath`), and the counts+state suffix rides
// the last path line when it fits or moves to its own indented line on
// narrow panels.
//
// The mock theme passes text through uncolored, so visibleWidth measures
// exactly what the assertions compare. A recording theme asserts the
// semantic color keys used per piece (mirrors the filechanges widget).
//
// Run: bun scripts/test-split-files.ts
import { visibleWidth } from "@earendil-works/pi-tui";

const { buildFilesRows, wrapPathSegments } = await import(
	"../pi/.pi/agent/extensions/split-files.ts"
);

/** Pass-through mock: rows come back plain, so string equality works. */
const plainTheme = { fg: (_c: string, t: string) => t };

/** Recording mock: collects the color keys the renderer asks for. */
function recordingTheme() {
	const used: string[] = [];
	return {
		used,
		fg: (c: string, t: string) => {
			used.push(c);
			return t;
		},
	};
}

function mk(over: Record<string, unknown> = {}) {
	return Object.assign(
		{
			path: "src/a.ts",
			absPath: "/x/src/a.ts",
			absolutePath: "/x/src/a.ts",
			kind: "modified",
			added: 12,
			removed: 3,
			binary: false,
			updatedAt: 0,
		},
		over,
	) as any;
}

const LONG = "src/very/deeply/nested/directory/structure/holding/an/extremely-long-descriptive-name.md";
const longEntry = mk({
	path: LONG,
	absPath: "/x/" + LONG,
	absolutePath: "/x/" + LONG,
	kind: "created",
	added: 1,
	removed: 0,
	repoState: "untracked",
});

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
	if (cond) {
		pass++;
		console.log(`  ok  ${name}`);
	} else {
		fail++;
		console.log(`FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
	}
}

// --- wrapPathSegments ------------------------------------------------------------
{
	check("short path: one line, unchanged", JSON.stringify(wrapPathSegments("a/b.ts", 10)) === '["a/b.ts"]');
	const w = wrapPathSegments(LONG, 22);
	check("wrap stays within the width", w.every((l) => l.length <= 22), w);
	check("wrap lines end on separators or are full-width hard breaks", w.slice(0, -1).every((l) => l.endsWith("/") || l.length === 22), w);
	check("wrap reconstructs the full path", w.join("") === LONG);
	check("hard-breaks a segment longer than the width", wrapPathSegments("abcdefghij", 4).every((l) => l.length <= 4) && wrapPathSegments("abcdefghij", 4).join("") === "abcdefghij");
	check("no-slash long path hard-breaks", wrapPathSegments("averylongfilename.md", 8).every((l) => l.length <= 8));
}

// --- single-row entries: shape and spacing ----------------------------------------
{
	const rows = buildFilesRows(plainTheme, [mk()], 60, 0);
	check("single row for a fitting entry", rows.length === 1, rows);
	check("row mirrors the widget format", rows[0] === " modified src/a.ts (+12/-3)", rows);
}
{
	// The live bug: "modified" had no trailing space, so the kind word and
	// the path ran together.
	const rows = buildFilesRows(plainTheme, [mk({ kind: "modified" })], 60, 0);
	check("modified keeps a space before the path", /^\s+modified\s+src/.test(rows[0]), rows);
}
{
	// All three kinds align the path at the same column (padEnd(9)).
	const rows = buildFilesRows(
		plainTheme,
		[mk({ kind: "created", added: 1, removed: 0 }), mk({ kind: "modified" }), mk({ kind: "deleted", added: 0, removed: 1 })],
		60,
		0,
	);
	const cols = rows.map((r) => r.indexOf("src/a.ts"));
	check("all kinds align the path column", cols.every((c) => c === cols[0]), { rows, cols });
}
{
	const rows = buildFilesRows(plainTheme, [mk({ binary: true })], 60, 0);
	check("binary entry shows (binary)", rows[0].includes("(binary)"), rows);
}
{
	const rows = buildFilesRows(plainTheme, [mk({ repoState: "untracked" })], 60, 0);
	check("repo state lands after the counts", rows[0].endsWith("(+12/-3) untracked"), rows);
}
{
	const rows = buildFilesRows(plainTheme, [], 40, 5);
	check("empty list: hint row plus blank filler to minRows", rows[0].includes("No changes yet") && rows.length === 5, rows);
}

// --- width safety: never clipped at the panel edge --------------------------------
{
	const testEntry = mk({ path: "test.txt", absPath: "/x/test.txt", absolutePath: "/x/test.txt", kind: "created", added: 1, removed: 0, repoState: "untracked" });
	// The live geometry: a 32-column panel produced 8-char fragments and
	// clipped "untracked" to "untrac". Sweep widths to prove neither can
	// happen at any width.
	let swept = true;
	for (let w = 14; w <= 120; w++) {
		const rows = buildFilesRows(plainTheme, [longEntry, testEntry], w, 0);
		const over = rows.filter((r) => visibleWidth(r) > w);
		if (over.length) {
			check(`no row overflows width ${w}`, false, over);
			swept = false;
			break;
		}
	}
	if (swept) check("no row overflows at any swept width (14..120)", true);

	// The reported case: at width 32 the full "untracked" word must render
	// and the path must wrap in wide chunks, not 8-character fragments.
	const rows32 = buildFilesRows(plainTheme, [longEntry], 32, 0);
	const stateRow = rows32.find((r) => r.includes("untracked"));
	check("untracked renders whole at width 32 (no edge clipping)", !!stateRow && stateRow.trim() === "(+1/-0) untracked", rows32);
	const pathRows = rows32.filter((r) => !r.includes("("));
	check("wrap chunks are wide (no 8-char fragments)", pathRows.every((r) => r.trim().length > 8), rows32);
	check("continuation lines carry the hanging indent (10 cols)", pathRows.slice(1).every((r) => r.startsWith(" ".repeat(10))), rows32);
}

// --- suffix placement -------------------------------------------------------------
{
	// Wide panel: the suffix rides the last wrapped path line.
	const wide = buildFilesRows(plainTheme, [longEntry], 100, 0);
	check("wide panel: suffix rides the last path line", wide.some((r) => r.includes("descriptive-name.md (+1/-0) untracked")), wide);
	check("wide panel: no separate suffix line", wide.length === 2, wide);
	// Narrow panel: the suffix moves to its own indented line, whole.
	const narrow = buildFilesRows(plainTheme, [longEntry], 32, 0);
	const suffixRows = narrow.filter((r) => r.includes("(+1/-0)"));
	check("narrow panel: suffix on its own line, whole", suffixRows.length === 1 && suffixRows[0].trim() === "(+1/-0) untracked", narrow);
	check("narrow panel: suffix counts align under the path column", suffixRows[0].startsWith(" ".repeat(10)) && suffixRows[0][10] === "(", narrow);
}

// --- semantic colors mirror the filechanges widget --------------------------------
{
	const t = recordingTheme();
	buildFilesRows(t, [mk({ kind: "modified", added: 1, removed: 2, repoState: "unstaged" })], 60, 0);
	check("kind uses the modified color key (warning)", t.used.includes("warning"), t.used);
	check("counts use diff colors + dim parens", t.used.includes("toolDiffAdded") && t.used.includes("toolDiffRemoved") && t.used.includes("dim"), t.used);
	check("path uses text color key", t.used.includes("text"), t.used);
	check("repo state uses its semantic color key (muted for unstaged)", t.used.includes("muted"), t.used);
}

console.log("");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
