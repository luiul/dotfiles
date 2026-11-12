import { Input, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, Focusable, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { guideRows, intelligence, loadEvidence, plain, price } from "./data.ts";
import type { GuideRow, LocalEvidence } from "./data.ts";

type Cell = { text: string; warning?: boolean };
type Metric = { label: string; cells: [Cell, Cell] };
const cell = (text: string, warning = false): Cell => ({ text, warning });
const usd = (value: number) => `$${value.toFixed(5)}`;

export class GuideView implements Component, Focusable {
	readonly capturesViewportInput = true;
	private input = new Input({ prompt: "Find model: " });
	private selected: [number, number];
	private column: 0 | 1 = 1;
	private search = false;
	private details = false;
	private offset = 0;
	private pageSize = 1;
	private contentSize = 1;
	private choices: number[] = [];
	private choice = 0;
	private hasFocus = false;
	get focused() { return this.hasFocus; }
	set focused(value: boolean) { this.hasFocus = value; this.input.focused = value && this.search; }

	constructor(private rows: GuideRow[], private theme: Theme, private kb: KeybindingsManager,
		private tui: TUI, private done: () => void, initial = "", private warning?: string) {
		const active = Math.max(0, rows.findIndex(row => row.current !== undefined));
		this.selected = [active, rows.length > 1 ? (active + 1) % rows.length : active];
		if (initial) {
			const match = rows.findIndex(row => this.matches(row, initial));
			if (match >= 0) this.choose(match);
		}
	}

	private matches(row: GuideRow, query: string) {
		return query.toLowerCase().trim().split(/\s+/).filter(Boolean).every(word =>
			`${row.key} ${row.model.name} ${row.role} ${row.purpose}`.toLowerCase().includes(word));
	}

	// Avoid duplicate columns without changing the session's authoritative scope.
	private choose(index: number) {
		const other = this.column === 0 ? 1 : 0;
		if (this.rows.length > 1 && index === this.selected[other]) this.selected[other] = this.selected[this.column];
		this.selected[this.column] = index;
		this.offset = 0;
	}

	private move(delta: number) {
		if (this.rows.length < 2) return;
		const other = this.column === 0 ? 1 : 0;
		let next = this.selected[this.column];
		do { next = (next + delta + this.rows.length) % this.rows.length; } while (next === this.selected[other]);
		this.choose(next);
	}

	private filter() {
		this.choices = this.rows.map((_, index) => index).filter(index => this.matches(this.rows[index], this.input.getValue()));
		this.choice = 0;
	}

	private local(row: GuideRow): LocalEvidence | undefined {
		const local = row.evidence?.local;
		// Do not project local costs onto a different effort or a future snapshot.
		return local && local.effort === row.configured && local.date <= new Date().toISOString().slice(0, 10) ? local : undefined;
	}

	private metrics(pair: [GuideRow, GuideRow], section: "decision" | "local" | "details"): Metric[] {
		const metric = (label: string, value: (row: GuideRow) => Cell): Metric => ({ label, cells: pair.map(value) as [Cell, Cell] });
		if (section === "decision") return [
			metric("Role", row => cell(row.role || "No curated role")),
			metric("Best use", row => cell(row.purpose || "No curated purpose")),
			metric("Thinking pin", row => cell(row.configured ?? "Unpinned")),
			metric("Current effort", row => cell(row.current ?? "Not active")),
			metric("Intelligence", row => {
				const ii = intelligence(row);
				return cell(ii.warning ? `Unknown at ${row.configured ?? "unpinned"}` : `${row.evidence!.score} @ ${row.evidence!.effort}`, ii.warning);
			}),
			metric("Published score", row => cell(row.evidence ? `${row.evidence.score} @ ${row.evidence.effort}` : "Unknown", intelligence(row).warning)),
			metric("Input /M tokens", row => cell(price(row.model.cost?.input))),
			metric("Output /M tokens", row => cell(price(row.model.cost?.output))),
		];
		if (section === "local") {
			const local = (label: string, value: (e: LocalEvidence) => string) => metric(label, row => {
				const e = this.local(row);
				return cell(e ? value(e) : row.evidence?.local?.date && row.evidence.local.date > new Date().toISOString().slice(0, 10)
					? "Future snapshot ignored" : row.evidence?.local ? `Not tested at ${row.configured ?? "unpinned"}` : "Not tested", !e);
			});
			return [
				metric("Test snapshot", row => cell(row.evidence?.local ? `${row.evidence.local.date} / ${row.evidence.local.effort}` : "Not tested")),
				local("Small code checks", e => `${e.small.passed}/${e.small.checked} passed (hidden tests)`),
				local("SQL / review", e => e.small.note),
				local("Small batch spend", e => `${usd(e.small.totalUsd)} / ${e.small.runs} tasks`),
				local("Mean small run", e => usd(e.small.totalUsd / e.small.runs)),
				local("Grove bug patches", e => `${e.grove.passed}/${e.grove.runs} passed; no test feedback${e.grove.timedOut ? `; ${e.grove.timedOut} timeout` : ""}`),
				local("Grove spend/pass", e => e.grove.passed ? usd(e.grove.totalUsd / e.grove.passed) : `No passing patch; ${usd(e.grove.totalUsd)} spent`),
			];
		}
		return [
			metric("Provider / model", row => cell(row.key)),
			metric("Pin source", row => cell(row.effortSource)),
			metric("Cache read /M", row => cell(price(row.model.cost?.cacheRead))),
			metric("Cache write /M", row => cell(price(row.model.cost?.cacheWrite))),
			metric("Context tokens", row => cell(Number.isFinite(row.model.contextWindow) ? row.model.contextWindow.toLocaleString("en-US") : "Unknown")),
			metric("Benchmark", row => cell(row.evidence ? `${row.evidence.benchmark} ${row.evidence.version}` : "Unknown")),
			metric("Reviewed", row => cell(row.evidence?.reviewed ?? "Unknown", !!row.evidence && row.evidence.reviewed > new Date().toISOString().slice(0, 10))),
			metric("Score qualifier", row => cell(row.evidence?.qualifier ?? "Match of effort is not proof of provider parity.", !!row.evidence?.qualifier)),
			metric("Score source", row => cell(row.evidence?.url ?? "Unknown")),
			metric("Local source", row => cell(row.evidence?.local?.source ?? "Unknown")),
		];
	}

	private table(metrics: Metric[], width: number): string[] {
		const labelWidth = width >= 70 ? 21 : 12;
		const valueWidth = Math.floor((width - labelWidth - 6) / 2);
		const pad = (text: string, size: number) => {
			const bounded = truncateToWidth(text, size);
			return bounded + " ".repeat(Math.max(0, size - visibleWidth(bounded)));
		};
		const sep = this.theme.fg("dim", " │ ");
		const lines: string[] = [];
		for (const metric of metrics) {
			const values = metric.cells.map(c => wrapTextWithAnsi(plain(c.text), valueWidth));
			const labels = wrapTextWithAnsi(metric.label, labelWidth);
			for (let i = 0; i < Math.max(labels.length, ...values.map(v => v.length)); i++) {
				lines.push(this.theme.fg("muted", pad(labels[i] ?? "", labelWidth)) + sep + values.map((v, side) =>
					this.theme.fg(metric.cells[side].warning ? "warning" : "text", pad(v[i] ?? "", valueWidth))).join(sep));
			}
		}
		return lines;
	}

	private pages(blocks: { lines: string[]; label?: string }[], size: number, width: number): string[][] {
		const pages: string[][] = [[]];
		for (const block of blocks) {
			let lines = block.lines;
			if (pages.at(-1)!.length + lines.length > size && pages.at(-1)!.length) pages.push([]);
			// Normal metrics stay whole. Oversized source URLs keep a clear continuation label.
			while (lines.length > size) {
				pages.at(-1)!.push(...lines.slice(0, size));
				lines = lines.slice(size);
				pages.push([]);
				const continued = truncateToWidth(this.theme.fg("dim", `${block.label ?? "Evidence"} (continued)`), width);
				if (size > 1) lines = [continued, ...lines];
			}
			pages.at(-1)!.push(...lines);
		}
		return pages;
	}

	render(width: number): string[] {
		width = Math.max(1, Math.min(112, width));
		const height = Math.max(1, this.tui.terminal.rows - 8);
		if (width < 40 || height < 9) return ["Model guide", "Enlarge terminal for comparison", "Esc / Enter closes"]
			.slice(0, height).map(line => truncateToWidth(this.theme.fg("accent", line), width));
		const title = this.theme.fg("accent", this.theme.bold("Compare two scoped models (read-only)"));
		if (!this.rows.length) return [title, "", "No scope configured. Use native /model for the full catalog.", "Esc / Enter closes"]
			.flatMap(line => wrapTextWithAnsi(line, width)).slice(0, height);
		const pair = this.selected.map(index => this.rows[index]) as [GuideRow, GuideRow];
		const header = this.table([{ label: "Model", cells: pair.map((row, side) => cell(
			`${this.column === side ? "▶ " : ""}${plain(row.model.id)}`)) as [Cell, Cell] }], width)
			.map(line => this.theme.bold(line));
		const compact = width < 70 || height < 22;
		const top = [truncateToWidth(title, width), ...(compact ? [] : [""]), ...header,
			this.theme.fg("dim", `Editing ${this.column === 0 ? "LEFT" : "RIGHT"} · ${this.selected[this.column] + 1}/${this.rows.length} scoped models`), ""];
		if (this.warning) top.push(truncateToWidth(this.theme.fg("warning", this.warning), width));
		const hints = this.search ? (compact ? ["↑↓ match · Enter sets · Esc cancels"] : ["↑↓ match · Enter sets comparison · Esc cancels search"]) : compact ?
			["←→ side · ↑↓ model · PgUp/PgDn", "d details · / find · Esc/Enter closes", "/model selects outside this guide"] :
			["←→ column · ↑↓ model · PgUp/PgDn scroll", "d details · / find · Esc / Enter closes · /model selects"];
		this.pageSize = height - top.length - hints.length - 1;
		// A tall wrapped identity must not push navigation and close hints off-screen.
		if (this.pageSize < 2) return ["Model guide", "Enlarge terminal for comparison", "Esc / Enter closes"]
			.slice(0, height).map(line => truncateToWidth(this.theme.fg("accent", line), width));
		const metricBlocks = (section: "decision" | "local" | "details") => this.metrics(pair, section)
			.map(metric => ({ lines: this.table([metric], width), label: metric.label }));
		let pages: string[][];
		if (this.search) {
			// Pin the input while match navigation pages the search results.
			top.push(...this.input.render(width));
			this.pageSize = Math.max(1, this.pageSize - 1);
			const choices = this.choices.length ? this.choices.map((index, i) =>
				truncateToWidth(this.theme.fg(i === this.choice ? "accent" : "muted", `${i === this.choice ? "▶ " : "  "}${plain(this.rows[index].model.id)} · ${this.rows[index].role}`), width)) :
				[this.theme.fg("warning", "No matching models")];
			pages = this.pages(choices.map(line => ({ lines: [line] })), this.pageSize, width);
			this.offset = Math.floor(this.choice / this.pageSize);
		} else {
			const heading = (text: string) => ({ lines: [this.theme.fg("accent", this.theme.bold(text)), ""] });
			const blocks = [heading(this.details ? "Technical evidence" : "Choose for your task"),
				...metricBlocks(this.details ? "details" : "decision"),
				...(this.details ? [] : [{ lines: [""] }, heading("Local fixtures, narrow evidence"), ...metricBlocks("local"), { lines: [""] },
					{ lines: wrapTextWithAnsi(this.theme.fg("dim", "Pi cost estimates, not invoices. Four code checks, SQL and review. Grove: one bug repeated, no test feedback. No general ranking."), width) }])];
			pages = this.pages(blocks, this.pageSize, width);
		}
		this.contentSize = pages.length;
		this.offset = Math.min(this.offset, pages.length - 1);
		const content = pages[this.offset];
		return [...top, ...content, ...Array(Math.max(0, this.pageSize - content.length)).fill(""),
			this.theme.fg("dim", `${this.details ? "Details" : "Comparison"} ${this.offset + 1}/${pages.length}${this.offset < pages.length - 1 ? " · more below, PgDn" : " · end"}`),
			...hints.map(line => this.theme.fg("dim", line))].slice(0, height).map(line => truncateToWidth(line, width));
	}

	handleInput(data: string) {
		if (this.search) {
			if (this.kb.matches(data, "tui.select.cancel")) this.search = false;
			else if (this.kb.matches(data, "tui.select.confirm")) {
				if (this.choices.length) { this.choose(this.choices[this.choice]); this.search = false; }
			} else if (this.kb.matches(data, "tui.select.up")) this.choice = Math.max(0, this.choice - 1);
			else if (this.kb.matches(data, "tui.select.down")) this.choice = Math.min(Math.max(0, this.choices.length - 1), this.choice + 1);
			else { this.input.handleInput(data); this.filter(); }
			// Keep the selected search match within the scrollable viewport.
			if (!this.search) this.offset = 0;
		} else if (this.kb.matches(data, "tui.select.cancel") || this.kb.matches(data, "tui.select.confirm")) { this.done(); return; }
		else if (this.kb.matches(data, "tui.editor.cursorLeft")) { this.column = 0; this.offset = 0; }
		else if (this.kb.matches(data, "tui.editor.cursorRight")) { this.column = 1; this.offset = 0; }
		else if (this.kb.matches(data, "tui.select.up")) this.move(-1);
		else if (this.kb.matches(data, "tui.select.down")) this.move(1);
		else if (this.kb.matches(data, "tui.select.pageDown")) this.offset = Math.min(this.contentSize - 1, this.offset + 1);
		else if (this.kb.matches(data, "tui.select.pageUp")) this.offset = Math.max(0, this.offset - 1);
		else if (data === "d") { this.details = !this.details; this.offset = 0; }
		else if (data === "/") { this.search = true; this.input.setValue(""); this.filter(); this.offset = 0; }
		else if (this.kb.matches(data, "tui.input.tab")) { this.column = this.column === 0 ? 1 : 0; this.offset = 0; }
		this.input.focused = this.hasFocus && this.search;
		this.tui.requestRender();
	}

	invalidate() { this.input.invalidate(); }
}

export async function showGuide(pi: ExtensionAPI, ctx: ExtensionCommandContext, search: string) {
	const data = ctx.scopedModels.length ? await loadEvidence(new URL("../../model-guide.json", import.meta.url)) : { evidence: {} };
	const rows = guideRows(ctx.scopedModels, pi.getSettings(), ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		pi.getThinkingLevel(), data.evidence);
	await ctx.ui.custom<void>((tui, theme, kb, done) => new GuideView(rows, theme, kb, tui, () => done(), search, data.warning),
		{ blocked: { kind: "question", message: "Compare scoped models" } });
}
