/**
 * split-updates.ts — update notices for the split view.
 *
 * pi renders three startup notices as transcript-only UI blocks, with no
 * extension event and no session entry:
 *   - "Update Available"            (checkForNewPiVersion → pi.dev latest)
 *   - "Package Updates Available"  (DefaultPackageManager
 *                                   .checkForAvailableUpdates)
 *   - "What's New"                 (post-update changelog: init() reads
 *                                   settings.lastChangelogVersion, shows
 *                                   the newer CHANGELOG.md entries, and
 *                                   consumes the marker immediately)
 * In full transcript mode the left column shows pi's own blocks. In
 * response-only mode they are DROPPED — an information-loss hole in the
 * policy of split-response.ts (user decision 2026-10-24). This module closes
 * it for every layout state:
 *   - Tools panel event rows (split-panels.ts ingestEvent, stable ids) show
 *     the notices whenever the right column is visible.
 *   - UpdateNoticeBlock carries them into the response doc for response-only
 *     mode; split-response.ts re-appends the blocks at the doc TOP after
 *     every rebuild — the position pi's own transcript shows them at.
 *   - A PERSISTENT footer status line (ctx.ui.setStatus, key "split-updates",
 *     e.g. "pi 1.4.0 available · 3 package updates · 1 skill conflict") — the
 *     one surface visible in EVERY layout state, including response-only with
 *     the right column hidden on a long resumed session, where the doc-top
 *     block sits above the fold and no panel exists.
 *
 * Also mirrors pi's [Skill conflicts] startup block (same information-loss
 * class): pi renders it transcript-only from resource-loader diagnostics with
 * no extension event, so collectSkillCollisions() reproduces the scan through
 * public API pieces (SettingsManager.create + DefaultPackageManager.resolve
 * + the exported loadSkills) and gets the SAME collision diagnostics.
 *
 * The "What's New" changelog notice is CONDENSED (user decision 2026-10-24):
 * pi's own block carries the full entry (1.4.0's is 56 lines / 10K chars),
 * far too big for event rows (bodies cap at 2 lines even in full mode) or
 * for the response doc. One line names the version you are on now and links
 * the permanent full changelog; pi's own full block stays reachable
 * in-session because response-only mode DETACHES, not destroys, the chat
 * container. Detection needs no scan: pi overwrites the marker during
 * init(), before any session_start handler runs (verified from pi 1.4.0
 * dist source: extension modules import during runtime creation, before
 * InteractiveMode; session_start fires after the UI starts, after the
 * write), so the pre-update value is captured at MODULE IMPORT below — the
 * one moment it is readable. Read-only; pi owns the setting.
 *
 * Data comes through pi's PUBLIC API, so results match pi's own checks:
 *   - pi version: the same https://pi.dev/api/latest-version endpoint,
 *     same env guards (PI_OFFLINE, PI_SKIP_VERSION_CHECK), current version
 *     from the exported VERSION, and a compare that mirrors pi's semver
 *     semantics (see isNewerVersion for the one documented simplification).
 *   - package updates: the same exported DefaultPackageManager +
 *     SettingsManager classes interactive mode uses.
 *
 * Session start only (never /reload), deferred ~1.5s to match pi's async
 * startup checks; every error is swallowed — an extension must never crash
 * the TUI. --split-fake-updates returns fixture notices (no network) so
 * tests are deterministic.
 *
 * This module is a shared utility imported by split.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DefaultPackageManager,
	SettingsManager,
	VERSION,
	getAgentDir,
	loadSkills,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

// ─── types and session-lifetime notice state ──────────────────────────────────

/** One styled body segment: a theme color role plus its text. */
export type NoticeSegment = readonly [role: string, text: string];

export interface UpdateNotice {
	/** Stable id: dedupes panel rows and doc blocks across rebuilds. */
	id: string;
	title: string;
	/** One entry per logical line; each line is styled segments. */
	body: NoticeSegment[][];
}

export const PI_UPDATE_ID = "update:pi";
export const PACKAGE_UPDATES_ID = "update:packages";
export const SKILL_CONFLICTS_ID = "conflicts:skills";
export const CHANGELOG_WHATSNEW_ID = "changelog:whatsnew";

let activeNotices: UpdateNotice[] = [];

export function setUpdateNotices(list: UpdateNotice[]): void {
	activeNotices = list;
}

export function getActiveNotices(): readonly UpdateNotice[] {
	return activeNotices;
}

export function resetUpdateNotices(): void {
	activeNotices = [];
}

// ─── pi version check (mirrors dist/utils/version-check.js) ──────────────────

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
export const CHANGELOG_URL = "https://pi.dev/changelog";
const CHECK_TIMEOUT_MS = 10_000;

export interface PiRelease {
	version: string;
	note?: string;
}

/**
 * Is candidate newer than current, mirroring pi's isNewerPackageVersion:
 * when both parse as X.Y.Z, compare numerically (same numeric core: a
 * prerelease candidate is NOT newer than the release, a release candidate
 * IS newer than a prerelease; two prereleases compare as strings — the one
 * documented simplification, pi's semver compares dot identifiers
 * numerically, but pi releases are plain X.Y.Z so the edge never bites).
 * Anything unparsable falls back to string inequality, exactly like pi.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
	const parse = (v: string) => {
		const [core, pre] = v.trim().split("+")[0].split("-");
		const nums = core.split(".");
		if (nums.length !== 3) return null;
		if (nums.some((n) => n === "" || !/^\d+$/.test(n))) return null;
		return { nums: nums.map(Number), pre: pre ?? "" };
	};
	const a = parse(candidate);
	const b = parse(current);
	if (!a || !b) return candidate.trim() !== current.trim();
	for (let i = 0; i < 3; i++) {
		if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
	}
	// Same numeric core: release > prerelease; prerelease vs prerelease by string.
	if (a.pre === "" && b.pre === "") return false;
	if (a.pre === "") return true;
	if (b.pre === "") return false;
	return a.pre > b.pre;
}

/** Parse the latest-version API payload (never throws, mirrors pi's shape). */
export function parseLatestRelease(data: unknown): PiRelease | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const version = (data as { version?: unknown }).version;
	if (typeof version !== "string" || !version.trim()) return undefined;
	const noteRaw = (data as { note?: unknown }).note;
	const note =
		typeof noteRaw === "string" && noteRaw.trim() ? noteRaw.trim() : undefined;
	return { version: version.trim(), ...(note ? { note } : {}) };
}

/**
 * Fetch pi's latest release, honoring pi's own env guards. Plain fetch with
 * pi's 10s timeout, no retries (pi's default retry count is 0). Returns
 * undefined on any failure — a failed check must look like "no update".
 */
export async function fetchLatestPiRelease(): Promise<PiRelease | undefined> {
	if (process.env.PI_OFFLINE || process.env.PI_SKIP_VERSION_CHECK)
		return undefined;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
	try {
		const res = await fetch(LATEST_VERSION_URL, {
			headers: { accept: "application/json", "User-Agent": `pi/${VERSION}` },
			signal: controller.signal,
		});
		if (!res.ok) return undefined;
		return parseLatestRelease(await res.json());
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Package updates through pi's own exported classes — the same code path
 * interactive mode runs at startup (SettingsManager.create +
 * DefaultPackageManager), so results (and the internal PI_OFFLINE guard)
 * match pi's exactly. NOTE: the SettingsManager constructor is private; the
 * create() factory is the public entry (a direct `new SettingsManager`
 * throws, which once silently killed this whole check).
 */
export async function fetchPackageUpdates(
	ctx: ExtensionContext,
): Promise<string[]> {
	try {
		const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir());
		const pm = new DefaultPackageManager({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			settingsManager,
		});
		const updates = await pm.checkForAvailableUpdates();
		return updates.map((u) => u.displayName);
	} catch {
		return [];
	}
}

// ─── notice builders ─────────────────────────────────────────────────────────

/** Release note cap: plain muted text (no markdown), few short lines. */
const NOTE_MAX_LINES = 2;
const NOTE_MAX_CHARS = 160;

function noteSegments(note: string): NoticeSegment[][] {
	const lines = note
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(0, NOTE_MAX_LINES)
		.map((l) => (l.length > NOTE_MAX_CHARS ? l.slice(0, NOTE_MAX_CHARS - 1) + "…" : l));
	return lines.map((l) => [["muted", l] as NoticeSegment]);
}

export function buildPiUpdateNotice(release: PiRelease): UpdateNotice {
	const body: NoticeSegment[][] = [
		[
			["muted", `New version ${release.version} is available. Run `],
			["accent", "pi update"],
		],
		[["muted", "Changelog: "], ["accent", CHANGELOG_URL]],
	];
	if (release.note) body.push(...noteSegments(release.note));
	return { id: PI_UPDATE_ID, title: "Update Available", body };
}

export function buildPackageUpdatesNotice(packages: string[]): UpdateNotice {
	return {
		id: PACKAGE_UPDATES_ID,
		title: "Package Updates Available",
		body: [
			[
				["muted", "Package updates are available. Run "],
				["accent", "pi update --extensions"],
			],
			[["muted", "Packages:"]],
			...packages.map(
				(p) => [["text", `- ${p}`] as NoticeSegment] as NoticeSegment[],
			),
		],
	};
}

/** Plain-text body for the Tools panel event row (ingestEvent's body arg). */
export function noticeBodyText(n: UpdateNotice): string {
	return n.body.map((segs) => segs.map(([, text]) => text).join("")).join("\n");
}

// ─── skill conflicts (pi's [Skill conflicts] block) ─────────────────────────────

export interface SkillCollision {
	name: string;
	winnerPath: string;
	loserPath: string;
}

/**
 * Reproduce pi's startup skill scan through public API pieces: resolve the
 * skill paths the same way the resource loader does (DefaultPackageManager
 * .resolve), then run the same exported loadSkills scan. Returns the same
 * collision diagnostics interactive mode renders as its transcript-only
 * [Skill conflicts] block — which response-only mode drops (no extension
 * event exists for it).
 */
export async function collectSkillCollisions(
	ctx: ExtensionContext,
): Promise<SkillCollision[]> {
	try {
		const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir());
		const pm = new DefaultPackageManager({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			settingsManager,
		});
		const resolved = await pm.resolve();
		const skillPaths = resolved.skills
			.filter((s) => s.enabled && typeof s.path === "string")
			.map((s) => s.path);
		const result = loadSkills({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			skillPaths,
			includeDefaults: false,
		});
		const collisions: SkillCollision[] = [];
		for (const d of result.diagnostics as Array<Record<string, unknown>>) {
			const c = d.collision as
				| { resourceType?: string; name?: string; winnerPath?: string; loserPath?: string }
				| undefined;
			if (
				d.type === "collision" &&
				c?.resourceType === "skill" &&
				typeof c.name === "string" &&
				typeof c.winnerPath === "string" &&
				typeof c.loserPath === "string"
			) {
				collisions.push({
					name: c.name,
					winnerPath: c.winnerPath,
					loserPath: c.loserPath,
				});
			}
		}
		return collisions;
	} catch {
		return [];
	}
}

/**
 * The skill-conflicts notice, mirroring pi's own block shape (user report
 * 2026-10-23): one warning header per collision, the winner with a success ✓,
 * the loser with an error ✗ and "(skipped)".
 */
export function buildSkillConflictsNotice(
	collisions: SkillCollision[],
): UpdateNotice {
	return {
		id: SKILL_CONFLICTS_ID,
		title: "Skill conflicts",
		body: collisions.flatMap((c) => [
			[["warning", `\"${c.name}\" collision:`] as NoticeSegment],
			[["success", "✓"] as NoticeSegment, ["muted", ` ${c.winnerPath}`] as NoticeSegment],
			[["error", "✗"] as NoticeSegment, ["muted", ` ${c.loserPath} (skipped)`] as NoticeSegment],
		]),
	};
}

// ─── post-update changelog notice (pi's "What's New" block) ───────────────────

/**
 * The pre-update lastChangelogVersion, captured at MODULE IMPORT (see the
 * header: pi consumes the marker during init(), long before any
 * session_start handler runs, so this is the one moment it is readable).
 * Read-only — pi owns the setting and this module never writes it.
 */
const changelogMarkerAtImport: string | undefined = (() => {
	try {
		const raw: unknown = JSON.parse(
			readFileSync(join(getAgentDir(), "settings.json"), "utf8"),
		);
		const marker = (raw as { lastChangelogVersion?: unknown } | null)
			?.lastChangelogVersion;
		return typeof marker === "string" && marker ? marker : undefined;
	} catch {
		return undefined;
	}
})();

/**
 * The condensed "What's New" notice. Pure: undefined when nothing is new —
 * no marker (first install), an equal marker, or a downgrade (marker newer
 * than the running version). A resumed first session after an update still
 * gets the notice: pi skips its own display (and leaves the marker
 * unconsumed) for sessions that already have messages, so this catches
 * information pi's own transcript never renders.
 */
export function buildChangelogNotice(
	marker: string | undefined,
	currentVersion: string,
): UpdateNotice | undefined {
	if (!marker || marker === currentVersion) return undefined;
	if (!isNewerVersion(currentVersion, marker)) return undefined;
	return {
		id: CHANGELOG_WHATSNEW_ID,
		title: `What's New (${currentVersion})`,
		body: [
			[
				["muted", `Updated to v${currentVersion}. Full changelog: `] as NoticeSegment,
				["accent", CHANGELOG_URL] as NoticeSegment,
			],
		],
	};
}

// ─── collection + footer status ───────────────────────────────────────────────

/** The changelog notice plus both update checks plus the skill scan in one;
 * all local work first (the changelog notice is synchronous, the skill scan
 * is local) so they show even when the network is slow. Empty result =
 * nothing to show (also offline/errors). */
export async function collectStartupNotices(
	ctx: ExtensionContext,
): Promise<UpdateNotice[]> {
	const notices: UpdateNotice[] = [];
	const changelog = buildChangelogNotice(changelogMarkerAtImport, VERSION);
	if (changelog) notices.push(changelog);
	const collisions = await collectSkillCollisions(ctx);
	if (collisions.length > 0) notices.push(buildSkillConflictsNotice(collisions));
	const release = await fetchLatestPiRelease();
	if (release && isNewerVersion(release.version, VERSION)) {
		notices.push(buildPiUpdateNotice(release));
	}
	const packages = await fetchPackageUpdates(ctx);
	if (packages.length > 0) notices.push(buildPackageUpdatesNotice(packages));
	return notices;
}

/**
 * Compact footer status text for the pending notices (persistent for the
 * session, e.g. "pi 1.4.0 available · 3 package updates · 1 skill conflict").
 * The doc block rides the doc top and panel rows need the right column — the
 * footer is the one surface visible in EVERY layout state, including
 * response-only with the right column hidden on a long resumed session.
 */
export function noticesStatusText(
	notices: readonly UpdateNotice[],
): string | undefined {
	if (notices.length === 0) return undefined;
	const byId = new Map(notices.map((n) => [n.id, n]));
	const parts: string[] = [];
	const changelog = byId.get(CHANGELOG_WHATSNEW_ID);
	if (changelog) {
		const m = /What's New \((\S+)\)/.exec(changelog.title);
		parts.push(m ? `updated to ${m[1]}` : "updated");
	}
	const pi = byId.get(PI_UPDATE_ID);
	if (pi) {
		const m = /New version (\S+) is available/.exec(noticeBodyText(pi));
		parts.push(m ? `pi ${m[1]} available` : "pi update available");
	}
	const pkgs = byId.get(PACKAGE_UPDATES_ID);
	if (pkgs) {
		const count = pkgs.body.filter((segs) =>
			segs.some(([, t]) => t.startsWith("- ")),
		).length;
		parts.push(`${count} package update${count === 1 ? "" : "s"}`);
	}
	const conflicts = byId.get(SKILL_CONFLICTS_ID);
	if (conflicts) {
		const count = noticeBodyText(conflicts)
			.split("\n")
			.filter((l) => l.includes("collision:")).length;
		parts.push(`${count} skill conflict${count === 1 ? "" : "s"}`);
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** --split-fake-updates fixture: deterministic, no network, fake markers.
 * Changelog notice first, matching collectStartupNotices order. */
export function fakeUpdateNotices(): UpdateNotice[] {
	return [
		buildChangelogNotice("1.0.0", "999.0.0")!,
		buildSkillConflictsNotice([
			{
				name: "fake-skill",
				winnerPath: "/winner/fake-skill/SKILL.md",
				loserPath: "/loser/fake-skill/SKILL.md",
			},
		]),
		buildPiUpdateNotice({
			version: "999.0.0",
			note: "Fake release note line one.\nFake line two (never shipped).",
		}),
		buildPackageUpdatesNotice(["fake-package-a", "fake-package-b"]),
	];
}

// ─── doc block component ─────────────────────────────────────────────────────

/**
 * The framed notice block for the response doc, mirroring pi's own
 * transcript block: warning stroke, bold warning title, wrapped body
 * (muted instruction with accent command/link, plain-text note), warning
 * stroke. Theme resolves LAZILY at render time, so blocks appended during
 * session_start still color correctly on the first frame (RowDivider
 * pattern from split-render.ts).
 */
export class UpdateNoticeBlock implements Component {
	readonly noticeId: string;
	constructor(
		private getTheme: () => Theme | null,
		private notice: UpdateNotice,
	) {
		this.noticeId = notice.id;
	}
	render(width: number): string[] {
		const th = this.getTheme();
		if (!th) return [];
		const stroke = th.fg("warning", "─".repeat(Math.max(0, width)));
		// The title wraps too, so the block never overflows even at widths no
		// real layout produces (the doc keeps ≥ 30 cols; the longest title is 26).
		const titleRows = wrapTextWithAnsi(
			th.bold(th.fg("warning", this.notice.title)),
			Math.max(1, width),
		);
		const lines: string[] = ["", stroke, ...titleRows];
		const bodyWidth = Math.max(1, width - 2);
		for (const segs of this.notice.body) {
			const styled = segs
				.map(([role, text]) => th.fg(role as never, text))
				.join("");
			for (const frag of wrapTextWithAnsi(styled, bodyWidth)) {
				lines.push(" " + frag);
			}
		}
		lines.push(stroke);
		return lines;
	}
	invalidate(): void {}
	dispose(): void {}
}
