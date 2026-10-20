/**
 * split-sticky.ts — sticky user prompt bar for the split layout's left
 * column (VS Code sticky scroll for a chat transcript).
 *
 *   ┌ left column ────────────────────────────┐
 *   │ ▌ second prompt …            (sticky)   │ ← pinned while its prompt
 *   │ ──────────────────────────────           │    is scrolled above view
 *   │ ... transcript content (scrolled) ...     │
 *   │ > editor dock (pi's own)                 │
 *   └──────────────────────────────────────────┘
 *
 * Behavior (user decision 2026-10-17, all-recommended round):
 * - SCROLL AWARE: the bar shows the user prompt that OWNS the top visible
 *   line — the last user message whose rendered block starts above the
 *   viewport top. Scrolling through history walks the pinned prompt turn by
 *   turn.
 * - AUTO HIDE: the bar disappears when the owning prompt's first line is
 *   itself visible (start >= scrollTop), when no prompt owns the top line
 *   (above the first prompt, or an empty transcript), or when the prompt
 *   has no text (image-only turns — same policy as the response doc).
 * - Left column only, max 3 text rows + 1 separator row, ellipsis when
 *   truncated, styled with the same userMessage tokens as real prompts.
 *
 * Cost model: per frame the walk is O(n) WeakMap lookups and instanceof
 * checks with NO component re-render (heights are cached per component per
 * width). Components AFTER the last user message are never measured: no
 * user prompt's start offset can depend on them, and they are exactly the
 * ones that mutate in place while streaming — so the cache can never go
 * stale mid-turn and no event-driven invalidation is needed. A doc rebuild
 * (tree switch, compaction) swaps in fresh component objects, which
 * re-measure lazily through the same WeakMap.
 *
 * Sources: full transcript mode introspects pi's base root (VStack[
 * transcriptScrollView, dock] — the ScrollView child is documentContainer,
 * whose chat Container holds the message components); response-only mode
 * uses the response doc singleton from split-response.ts. The two doc
 * shapes are normalized by walkList(): either messages are direct children
 * (response doc) or one child container holds them (native doc), with the
 * sibling header containers measured whole.
 *
 * This module is a shared utility imported by split.ts. pi auto-discovers
 * every *.ts file in this directory as an extension and requires a default
 * factory export, so expose a no-op one here.
 */

import {
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	UserMessageComponent,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";

/** Max text rows pinned above the transcript (plus 1 separator row). */
const MAX_TEXT_ROWS = 3;

export interface StickyDocSource {
	/** The ScrollView over the doc (scrollTop, viewportHeight, getContentWidth). */
	sv: unknown;
	/** The ScrollView's child: the message document component. */
	doc: unknown;
}

/** Live source accessor; null while the view is unavailable. */
export type StickySource = () => StickyDocSource | null;

/**
 * Shared per-component height cache (component → content width → rendered
 * rows). Module-level so a recomposed bar (theme swap, resize) keeps every
 * measurement: ANSI styling and geometry do not change row counts.
 */
const heightCache = new WeakMap<object, Map<number, number>>();

function isUserMessage(c: any): c is { text: string } {
	if (!(c instanceof UserMessageComponent)) return false;
	const t = (c as any).text;
	return typeof t === "string" && t.trim().length > 0;
}

function measureHeight(c: any, width: number): number {
	let byWidth = heightCache.get(c);
	if (!byWidth) {
		byWidth = new Map();
		heightCache.set(c, byWidth);
	}
	const hit = byWidth.get(width);
	if (typeof hit === "number") return hit;
	let h = 1;
	try {
		const lines = c.render(width);
		h = Array.isArray(lines) ? Math.max(1, lines.length) : 1;
	} catch {
		h = 1; // never let a broken component break the layout
	}
	byWidth.set(width, h);
	return h;
}

/**
 * Extract pi's transcript ScrollView from the base root: the VStack entry
 * component that owns a `child` property is the ScrollView (the dock does
 * not own one) — the mirror of baseDockOf() in split-response.ts.
 */
export function findTranscriptScrollView(base: any): any | null {
	const entries = base?.entries;
	if (!Array.isArray(entries)) return null;
	for (const e of entries) {
		const c = e?.component;
		if (c && Object.hasOwn(c, "child")) return c;
	}
	return null;
}

/** The pinned prompt the bar is currently showing (null = hidden). */
export interface StickyOwner {
	/** Content row where the prompt's first rendered line sits. */
	start: number;
	text: string;
}

/**
 * The sticky bar component. render() is called once per frame by the layout
 * engine (basis "auto" measures intrinsic height through render), so it is
 * the single decision point: resolve the owning prompt, return its pinned
 * rows or [] to hide (an empty bar takes no layout space).
 *
 * Mouse events are unhandled on purpose: wheel over the bar passes through
 * to the nearest ScrollView (the transcript), like the drag divider.
 */
export class StickyPromptBar implements Component {
	private rowsKey: string | null = null;
	private rows: string[] | null = null;

	constructor(
		private theme: Theme,
		private source: StickySource,
	) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const src = this.source();
		const sv = src?.sv as any;
		const doc = src?.doc;
		if (!sv || !doc) return [];

		// The ScrollView may reserve a scrollbar column; measure children at
		// exactly the content width it passes to its own child.
		let contentWidth = width;
		try {
			const cw = sv.getContentWidth(width);
			if (typeof cw === "number" && cw > 0) contentWidth = cw;
		} catch {
			/* keep full width */
		}
		let scrollTop = 0;
		try {
			scrollTop = typeof sv.scrollTop === "number" ? sv.scrollTop : 0;
		} catch {
			/* stay at top */
		}

		const units = this.walkList(doc);
		if (!units) return [];
		const owner = this.findOwner(units, contentWidth, scrollTop);
		if (!owner) return [];
		return this.buildRows(owner.text, width);
	}

	/**
	 * Normalize either doc shape into a flat list of walk units:
	 * - response doc: message components are direct children;
	 * - native transcript doc: [header…, chatContainer, …] — expand the
	 *   chat container, measure the siblings whole.
	 * Returns null when the doc holds no text-bearing user message yet
	 * (nothing can ever be pinned).
	 */
	private walkList(doc: any): any[] | null {
		const kids = doc?.children;
		if (!Array.isArray(kids)) return null;
		if (kids.some(isUserMessage)) return kids.slice();
		for (const k of kids) {
			const grand = k?.children;
			if (Array.isArray(grand) && grand.some(isUserMessage)) {
				const units: any[] = [];
				for (const k2 of kids) {
					if (k2 === k) units.push(...grand);
					else units.push(k2);
				}
				return units;
			}
		}
		return null;
	}

	/**
	 * Last user message whose block starts at or above the viewport top.
	 * Starts are strictly increasing, so the walk stops measuring at the
	 * first prompt that starts below the top line — everything after it,
	 * including the streaming tail, is never measured.
	 */
	private findOwner(
		units: any[],
		width: number,
		scrollTop: number,
	): StickyOwner | null {
		const userIdx: number[] = [];
		for (let i = 0; i < units.length; i++) {
			if (isUserMessage(units[i])) userIdx.push(i);
		}
		if (userIdx.length === 0) return null;
		let owner: StickyOwner | null = null;
		let cursor = 0;
		let offset = 0;
		for (const ui of userIdx) {
			while (cursor < ui) {
				offset += measureHeight(units[cursor], width);
				cursor++;
			}
			const h = measureHeight(units[ui], width);
			cursor = ui + 1;
			offset += h;
			const start = offset - h;
			if (start > scrollTop) break; // later prompts start even lower
			owner = { start, text: units[ui].text };
		}
		// start == scrollTop means the prompt's first line IS the top visible
		// row: it is on screen, pinning it would duplicate it (VS Code parity).
		return owner && owner.start < scrollTop ? owner : null;
	}

	/** Pinned rows for one prompt, cached per (text, width). */
	private buildRows(text: string, width: number): string[] {
		const key = `${width}\u0000${text}`;
		if (this.rowsKey === key && this.rows) return this.rows;

		const th = this.theme;
		const avail = Math.max(1, width - 2); // ▌ marker + one leading space
		const wrapped = wrapTextWithAnsi(text, avail);
		const shown = wrapped.slice(0, MAX_TEXT_ROWS);
		if (wrapped.length > MAX_TEXT_ROWS) {
			let last = shown[MAX_TEXT_ROWS - 1];
			if (visibleWidth(last) + 2 > avail) {
				last = last.slice(0, Math.max(0, avail - 2));
			}
			shown[MAX_TEXT_ROWS - 1] = last + th.fg("dim", " …");
		}

		const marker = th.fg("accent", "▌");
		const rows = shown.map((line) => {
			// Content area after the marker: one space + text, bg-padded to
			// exactly width so the pinned block reads as a solid strip.
			const pad = Math.max(0, width - 2 - visibleWidth(line));
			return (
				marker +
				th.bg("userMessageBg", th.fg("userMessageText", ` ${line}`) + " ".repeat(pad))
			);
		});
		// Separator: the pinned block's lower edge (VS Code underline).
		rows.push(th.fg("borderMuted", "─".repeat(Math.max(0, width))));

		this.rowsKey = key;
		this.rows = rows;
		return rows;
	}

	invalidate(): void {
		this.rowsKey = null;
		this.rows = null;
	}

	handleMouse(_event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return undefined; // wheel passes through to the transcript
	}

	dispose(): void {
		this.rowsKey = null;
		this.rows = null;
	}
}

/**
 * This module is a shared utility imported by split.ts. pi auto-discovers
 * every *.ts file in this directory as an extension and requires a default
 * factory export, so expose a no-op one here.
 */
export default function (_pi: ExtensionAPI) {
	/* no-op: shared sticky-bar module, not an extension */
}
