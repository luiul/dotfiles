/**
 * split-render.ts — shared rendering primitives for the split extension's
 * right-column panels (thinking / tools / file changes).
 *
 * Minimal-frame policy (user decision 2026-10-16): no box borders, no
 * per-panel border flanks. A panel is:
 *
 *     Thinking ────────────────────────      ← 1-row compact header
 *      ⋯ body rows, cached (version,width)    ← ScrollView over RecentBody
 *
 * The vertical divider column is the panels' left frame edge. Panels draw
 * NO rail of their own at rest; while the user scrolls, a transient
 * scrollbar (border-styled track, accent thumb) overlays the body's last
 * column and fades after the scroll stops (#46). Panels stack
 * directly on each other; the next panel's header row is the separator,
 * so the column reads as one continuous right column.
 *
 * Measurement-safe architecture (inherited from upstream): MeasurementSafeVStack
 * makes the layout engine's discarded intrinsic-height measurement passes
 * O(1) instead of eagerly rendering whole subtrees every keystroke frame.
 */

import {
	ScrollView,
	VStack,
	type Component,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

// ─── measurement-safe wrapper ─────────────────────────────────────────────────

/**
 * A VStack whose component-level render() is a constant sentinel. The layout
 * engine checks LAYOUT_NODE before plain render (layoutComponent), so real
 * layout/painting is untouched — but the engine's DISCARDED intrinsic-height
 * measurement passes call component.render() and now cost O(1) instead of
 * eagerly rendering the whole subtree (panels + transcript) per frame.
 */
export class MeasurementSafeVStack extends VStack {
	render(_width: number): string[] {
		return [""];
	}
}

// ─── recent body (cached, bounded window) ─────────────────────────────────────

/** Body window: hard cap on FINAL VISUAL rows rendered by a panel body. */
const MAX_BODY_ROWS = 96;
/** Hard cap on raw chars processed per logical line (giant-line guard). */
const MAX_LINE_CHARS = 600;
/** Bounded width cache: current width + a small LRU of recent widths. */
const MAX_CACHED_WIDTHS = 4;

/**
 * Renders the recent window with no rail of its own at rest — the section
 * divider is the left frame edge; while scrolling, the ScrollView's
 * transient scrollbar (border-styled track, accent thumb) overlays the
 * body's last column.
 * Pads every row to EXACT width and always emits at least `minRows` rows so
 * the body stays rectangular when content is short. A (version, width)
 * cache keeps unchanged frames O(1) — pi's renderCache is fresh every frame.
 */
export class RecentBody {
	private cacheVersion = -1;
	private cacheByWidth = new Map<number, string[]>();

	constructor(
		private theme: Theme,
		private style: (line: string) => string,
		private lines: (width: number) => string[],
		private version: () => number,
		private empty: string,
		/** Rows to guarantee so the section height stays stable (viewport height). */
		private minRows: () => number,
	) {}

	render(width: number): string[] {
		const th = this.theme;
		const v = this.version();
		if (v !== this.cacheVersion) {
			this.cacheVersion = v;
			this.cacheByWidth.clear();
		}
		const cached = this.cacheByWidth.get(width);
		if (cached) {
			// Refresh recency so eviction is genuinely LRU, not FIFO.
			this.cacheByWidth.delete(width);
			this.cacheByWidth.set(width, cached);
			return cached;
		}
		const pad = (s: string) =>
			" ".repeat(Math.max(0, width - visibleWidth(s)));
		// Wrap newest-first, keep only the newest MAX_BODY_ROWS visual rows;
		// giant logical lines are suffix-capped before wrapping. Fragments of
		// ONE source line are wrapped as a group and inserted in order; the
		// MAX_BODY_ROWS cap counts VISUAL rows, so one long line cannot blow
		// past the cap at narrow widths. A group that would straddle the cap
		// is skipped whole; a single group larger than the whole cap keeps
		// only its newest fragments.
		const src = this.lines(width);
		const groups: string[][] = [];
		let used = 0;
		for (let i = src.length - 1; i >= 0; i--) {
			const line =
				src[i].length > MAX_LINE_CHARS
					? "… " + src[i].slice(-MAX_LINE_CHARS + 1)
					: src[i];
			// One leading space after the divider; the freed rail column goes
			// back to the content (the wrap width is one wider than in the
			// railed design). No rail: the divider is the left frame edge.
			const frags = wrapTextWithAnsi(
				this.style(line),
				Math.max(1, width - 2),
			).map((w: string) => " " + w);
			if (used + frags.length > MAX_BODY_ROWS) {
				if (groups.length === 0 && frags.length > MAX_BODY_ROWS)
					groups.push(frags.slice(frags.length - MAX_BODY_ROWS));
				break;
			}
			groups.push(frags);
			used += frags.length;
		}
		const rows: string[] = [];
		for (let g = groups.length - 1; g >= 0; g--)
			for (const f of groups[g]) rows.push(f);
		let out: string[];
		if (rows.length === 0) {
			const empty = " " + th.fg("dim", this.empty);
			out = [empty + pad(empty)];
		} else {
			out = rows.map((r) => r + pad(r));
		}
		// Fill short content up to minRows so the section height stays stable.
		const min = Math.max(1, this.minRows());
		const filler = " ".repeat(Math.max(0, width));
		while (out.length < min) out.push(filler);
		this.cacheByWidth.set(width, out);
		// Bound the number of cached widths (Map preserves insertion order;
		// hits refresh recency above, so the first key is least-recent used).
		while (this.cacheByWidth.size > MAX_CACHED_WIDTHS) {
			const oldest = this.cacheByWidth.keys().next().value as number;
			this.cacheByWidth.delete(oldest);
		}
		return out;
	}

	invalidate(): void {
		this.cacheVersion = -1;
		this.cacheByWidth.clear();
	}

	dispose(): void {}
}

// ─── compact header ───────────────────────────────────────────────────────────

/**
 * 1-row panel header: the title in muted at rest and in accent while the
 * panel's source is streaming (#48: the live panel is loud, idle chrome is
 * quiet), a dim "…" indicator while streaming, then a border ─ fill to
 * EXACT width. This row doubles as the separator between stacked panels,
 * so no extra separator rows exist.
 */
export class CompactHeader implements Component {
	constructor(
		private theme: Theme,
		private title: string,
		private streaming: () => boolean = () => false,
	) {}

	render(width: number): string[] {
		const th = this.theme;
		// The title color is derived from state, not configured per panel.
		const head =
			" " + th.fg(this.streaming() ? "accent" : "muted", this.title);
		const withDot = this.streaming() ? head + th.fg("dim", " …") : head;
		const padded = withDot + " ";
		const fillW = Math.max(0, width - visibleWidth(padded));
		return [padded + th.fg("border", "─".repeat(fillW))];
	}

	invalidate(): void {}

	dispose(): void {}
}

// ─── block divider ───────────────────────────────────────────────────────────

/**
 * One block-divider stroke: a full-width borderMuted ─ line (modern
 * separator, 2026-10-20: pi's "subtle borders" token, dimmer than dim in
 * both bundled themes; the sticky bar's separator row uses the same color).
 */
export function blockRuleRow(theme: Theme, width: number): string {
	return theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
}

/**
 * The block divider, inserted AFTER response blocks in the response doc
 * (between a finished assistant answer and whatever block follows): one
 * blank row, then the full-width stroke. The blank above is the divider's
 * own (pi's assistant components end flush, measured in a real tmux run,
 * 2026-10-20); the blank below comes from the next block's leading row, so
 * the visual gap is a compact symmetric one row on each side. Resolves the
 * theme LAZILY at render time, so a doc rebuilt during session_start still
 * shows its dividers from the first frame on. Stateless, O(1).
 */
export class RowDivider implements Component {
	constructor(private getTheme: () => Theme | null) {}
	render(width: number): string[] {
		const th = this.getTheme();
		return ["", th ? blockRuleRow(th, Math.max(0, width)) : ""];
	}
	invalidate(): void {}
	dispose(): void {}
}

// ─── framed panel ────────────────────────────────────────────────────────────

export interface FramedPanelSpec {
	title: string;
	streaming?: () => boolean;
	/** Newest-first logical lines for the body. */
	lines: (width: number) => string[];
	/** Version counter; any bump invalidates the body cache. */
	version: () => number;
	/** Dim placeholder line when there is no content. */
	empty: string;
	/** The panel's total row budget (header + body). */
	rows: () => number;
	/** Per-line style hook (e.g. thinkingText tint). */
	style?: (line: string) => string;
}

/**
 * One compact panel: 1-row header + ScrollView body filling the remaining
 * rows. The ScrollView follows the end (newest content), contains overscroll
 * (wheel chains to the nearest ScrollView at the panel edges), and shows a
 * transient scrollbar only while the user scrolls.
 */
export function framedPanel(theme: Theme, spec: FramedPanelSpec): Component {
	const header = new CompactHeader(
		theme,
		spec.title,
		spec.streaming ?? (() => false),
	);
	const body = new RecentBody(
		theme,
		spec.style ?? ((l: string) => l),
		spec.lines,
		spec.version,
		spec.empty,
		() => Math.max(1, spec.rows() - 1),
	);
	const scroll = new ScrollView(body, {
		follow: "end",
		overscroll: "contain",
		scrollbar: "auto",
		scrollbarTrackStyle: (t: string) => theme.fg("border", t),
		// Map the IDLE heavy thumb ┃ to the track's light │ glyph so the
		// transient rail reads as a uniform │ column while visible but idle;
		// the ACTIVE thumb keeps █ in accent for scroll feedback.
		scrollbarThumbStyle: (t: string) =>
			theme.fg(t === "█" ? "accent" : "border", t === "┃" ? "│" : t),
	});
	return new MeasurementSafeVStack([
		{ component: header, basis: 1, grow: 0, shrink: 0 },
		{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	]);
}
