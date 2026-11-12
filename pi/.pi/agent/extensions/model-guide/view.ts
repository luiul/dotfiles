import { Container, Input, SelectList, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, Focusable, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { detailLines, guideRows, intelligence, loadEvidence, plain } from "./data.ts";
import type { GuideRow } from "./data.ts";

export class GuideView implements Component, Focusable {
	readonly capturesViewportInput = true;
	private input = new Input({ prompt: "Search: " });
	private list!: SelectList;
	private filtered: GuideRow[] = [];
	private maxVisible = 0;
	private detailFocus = false;
	private detailOffset = 0;
	private detailHeight = 1;
	private detailCount = 0;
	get focused() { return this.input.focused; }
	set focused(value: boolean) { this.input.focused = value; }

	constructor(private rows: GuideRow[], private theme: Theme, private kb: KeybindingsManager,
		private tui: TUI, private done: () => void, initial = "", private warning?: string) {
		this.input.setValue(initial);
		this.filter(7);
	}

	private roleColor(role: string) {
		if (role === "Budget") return "success";
		if (role === "Think" || role === "Vision") return "thinkingHigh";
		if (role === "Quick" || role === "Helper") return "muted";
		return "accent";
	}

	private filter(maxVisible: number) {
		const selected = this.list?.getSelectedItem()?.value;
		const words = this.input.getValue().toLowerCase().trim().split(/\s+/).filter(Boolean);
		this.filtered = this.rows.filter(row => words.every(word =>
			`${row.key} ${row.model.name} ${row.role} ${row.purpose}`.toLowerCase().includes(word)));
		const items = this.filtered.map(row => ({ value: row.key,
			label: `${row.current ? "✓ " : ""}${row.role ? `${row.role}  ` : ""}${plain(row.model.id)}`,
			description: `${row.configured ?? "unpinned"} · ${row.purpose}` }));
		this.maxVisible = maxVisible;
		this.list = new SelectList(items, maxVisible, {
			selectedPrefix: s => this.theme.fg("accent", s),
			selectedText: s => this.theme.fg("accent", s),
			description: s => this.theme.fg("muted", s),
			scrollInfo: s => this.theme.fg("dim", s),
			noMatch: () => this.theme.fg("warning", "No matching models"),
		}, {
			minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 45,
			truncatePrimary: ({ text, maxWidth, item, isSelected }) => {
				const row = this.filtered.find(r => r.key === item.value)!;
				return this.theme.fg(isSelected ? "accent" : this.roleColor(row.role), truncateToWidth(text, maxWidth));
			},
		});
		this.list.onSelectionChange = () => { this.detailOffset = 0; };
		// Enter closes the guide. It never selects a model or persists settings.
		this.list.onSelect = this.done;
		this.list.onCancel = this.done;
		const index = items.findIndex(item => item.value === selected);
		if (index >= 0) this.list.setSelectedIndex(index);
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		const height = Math.max(1, this.tui.terminal.rows - 8);
		// Avoid wrapped headers and SelectList's fixed prefix on tiny surfaces.
		// Native cancel/confirm keys remain active, even when only one cell fits.
		if (width < 20 || height < 9) {
			return [this.theme.fg("accent", "Model guide"), this.theme.fg("warning", "Enlarge terminal for details"),
				this.theme.fg("dim", "Esc / Enter closes")].slice(0, height).map(line => truncateToWidth(line, width));
		}
		const maxVisible = Math.max(1, Math.min(7, Math.floor((height - 5) / 3)));
		if (maxVisible !== this.maxVisible) this.filter(maxVisible);
		const top = [truncateToWidth(this.theme.fg("accent", this.theme.bold("Scoped model guide (read-only)")), width), ...this.input.render(width)];
		if (this.warning) top.push(truncateToWidth(this.theme.fg("warning", this.warning), width));
		if (!this.rows.length) {
			return [...top, ...wrapTextWithAnsi("No scope configured. Use native /model for the full catalog.", width)].slice(0, height - 1)
				.concat(truncateToWidth(this.theme.fg("dim", "Esc / Enter closes"), width));
		}
		top.push(...this.list.render(width));
		const selected = this.filtered.find(row => row.key === this.list.getSelectedItem()?.value);
		const container = new Container();
		if (selected) {
			const ii = intelligence(selected);
			container.addChild(new Text(this.theme.fg(ii.warning ? "warning" : "text", ii.text), 0, 0));
			for (const line of detailLines(selected).filter(line => line.text !== ii.text)) {
				container.addChild(new Text(this.theme.fg(line.warning ? "warning" : "muted", line.text), 0, 0));
			}
		}
		const details = container.render(width);
		this.detailHeight = Math.max(0, height - top.length - 3);
		this.detailCount = details.length;
		this.detailOffset = Math.min(this.detailOffset, Math.max(0, details.length - this.detailHeight));
		const detailHeading = this.theme.fg("dim", `Details ${this.detailFocus ? "(focused) " : ""}${this.detailOffset + 1}/${Math.max(1, details.length)}`);
		return [...top, truncateToWidth(detailHeading, width), ...details.slice(this.detailOffset, this.detailOffset + this.detailHeight),
			truncateToWidth(this.theme.fg("dim", "Tab list/details · ↑↓ move · PgUp/PgDn"), width),
			truncateToWidth(this.theme.fg("dim", "Esc / Enter closes · /model selects"), width)];
	}

	handleInput(data: string) {
		if (this.kb.matches(data, "tui.select.cancel") || this.kb.matches(data, "tui.select.confirm")) {
			this.done();
			return;
		}
		if (this.kb.matches(data, "tui.input.tab")) this.detailFocus = !this.detailFocus;
		else if (this.detailFocus && (this.kb.matches(data, "tui.select.down") || this.kb.matches(data, "tui.select.pageDown"))) {
			this.detailOffset = Math.min(Math.max(0, this.detailCount - this.detailHeight),
				this.detailOffset + (this.kb.matches(data, "tui.select.pageDown") ? this.detailHeight : 1));
		} else if (this.detailFocus && (this.kb.matches(data, "tui.select.up") || this.kb.matches(data, "tui.select.pageUp"))) {
			this.detailOffset = Math.max(0, this.detailOffset - (this.kb.matches(data, "tui.select.pageUp") ? this.detailHeight : 1));
		} else if (["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"].some(key => this.kb.matches(data, key as any))) {
			this.list.handleInput(data);
		} else {
			const previous = this.input.getValue();
			this.input.handleInput(data);
			if (previous !== this.input.getValue()) { this.detailOffset = 0; this.filter(this.maxVisible); }
		}
		this.tui.requestRender();
	}

	invalidate() { this.input.invalidate(); this.list.invalidate(); }
}

export async function showGuide(pi: ExtensionAPI, ctx: ExtensionCommandContext, search: string) {
	const data = ctx.scopedModels.length ? await loadEvidence(new URL("../../model-guide.json", import.meta.url)) : { evidence: {} };
	const rows = guideRows(ctx.scopedModels, pi.getSettings(), ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		pi.getThinkingLevel(), data.evidence);
	await ctx.ui.custom<void>((tui, theme, kb, done) => new GuideView(rows, theme, kb, tui, () => done(), search, data.warning),
		{ blocked: { kind: "question", message: "Review scoped model details" } });
}
