/**
 * Enhanced status bar for pi (claude-hud inspired).
 *
 * Replaces the default footer with a two-line status bar:
 *
 *   <project>  ⎇ <branch> ●<dirty> ↑<ahead> ↓<behind>          <model> <thinking>
 *   <session>  ↑<in> ↓<out> ⊕<cache>  $<cost>        [██████░░░░] <pct>%  <tok>/<win>
 *
 * Git working-tree state (dirty count, ahead/behind) is polled on a timer and
 * cached, since the footer render path must stay synchronous.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);

const GIT_POLL_MS = 4000;

interface GitState {
	dirty: number;
	ahead: number;
	behind: number;
}

export default function (pi: ExtensionAPI) {
	let git: GitState = { dirty: 0, ahead: 0, behind: 0 };
	let timer: ReturnType<typeof setInterval> | undefined;

	const fmtTokens = (n: number): string => {
		if (n < 1000) return `${n}`;
		if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
		return `${(n / 1_000_000).toFixed(1)}M`;
	};

	// Sum token usage and cost across the current branch's assistant messages.
	const tally = (ctx: ExtensionContext) => {
		let input = 0,
			output = 0,
			cache = 0,
			cost = 0;
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message" && e.message.role === "assistant") {
				const u = (e.message as AssistantMessage).usage;
				input += u.input;
				output += u.output;
				cache += u.cacheRead + u.cacheWrite;
				cost += u.cost.total;
			}
		}
		return { input, output, cache, cost };
	};

	const refreshGit = async (ctx: ExtensionContext) => {
		try {
			const { stdout } = await execFileAsync("git", ["status", "--porcelain=2", "--branch"], {
				cwd: ctx.cwd,
				timeout: 2000,
			});
			const res = { stdout };
			let dirty = 0,
				ahead = 0,
				behind = 0;
			for (const line of res.stdout.split("\n")) {
				if (!line) continue;
				if (line.startsWith("# branch.ab ")) {
					const m = line.match(/\+(\d+)\s+-(\d+)/);
					if (m) {
						ahead = Number(m[1]);
						behind = Number(m[2]);
					}
				} else if (!line.startsWith("#")) {
					dirty++;
				}
			}
			git = { dirty, ahead, behind };
		} catch {
			git = { dirty: 0, ahead: 0, behind: 0 };
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		const startGitPoll = () => {
			void refreshGit(ctx);
			timer = setInterval(() => {
				void refreshGit(ctx);
			}, GIT_POLL_MS);
			timer.unref?.();
		};
		startGitPoll();

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => {
				void refreshGit(ctx).then(() => tui.requestRender());
			});

			// Re-render whenever git state refreshes on the timer.
			const tick = setInterval(() => tui.requestRender(), GIT_POLL_MS);

			const join = (left: string, right: string, width: number): string => {
				const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
				return truncateToWidth(left + " ".repeat(gap) + right, width);
			};

			const contextBar = (pct: number): string => {
				const slots = 10;
				const filled = Math.min(slots, Math.max(0, Math.round((pct / 100) * slots)));
				const color = pct >= 80 ? "error" : pct >= 50 ? "warning" : "success";
				const bar = theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(slots - filled));
				return `[${bar}]`;
			};

			return {
				dispose: () => {
					unsub();
					clearInterval(tick);
				},
				invalidate() {},
				render(width: number): string[] {
					const sm = ctx.sessionManager;
					const project = (ctx.cwd.split("/").pop() || ctx.cwd) ?? "";
					const branch = footerData.getGitBranch();
					const name = sm.getSessionName();
					const { input, output, cache, cost } = tally(ctx);
					const usage = ctx.getContextUsage();
					const model = ctx.model?.id ?? "no-model";

					// --- Line 1: project + git  |  model ---
					let l1 = theme.fg("accent", theme.bold(project));
					if (branch) {
						l1 += theme.fg("dim", "  ⎇ ") + theme.fg("muted", branch);
						if (git.dirty > 0) l1 += " " + theme.fg("warning", `●${git.dirty}`);
						if (git.ahead > 0) l1 += " " + theme.fg("dim", `↑${git.ahead}`);
						if (git.behind > 0) l1 += " " + theme.fg("dim", `↓${git.behind}`);
					}
					const r1 = theme.fg("dim", model);

					// --- Line 2: session + tokens + cost  |  context ---
					const parts2: string[] = [];
					if (name) parts2.push(theme.fg("accent", name));
					parts2.push(
						theme.fg("dim", "↑") +
							theme.fg("muted", fmtTokens(input)) +
							theme.fg("dim", " ↓") +
							theme.fg("muted", fmtTokens(output)) +
							theme.fg("dim", " ⊕") +
							theme.fg("muted", fmtTokens(cache)),
					);
					parts2.push(theme.fg("success", `$${cost.toFixed(3)}`));
					const l2 = parts2.join(theme.fg("dim", "  ·  "));

					let r2: string;
					if (usage && usage.tokens != null && usage.percent != null) {
						r2 =
							contextBar(usage.percent) +
							" " +
							theme.fg("muted", `${usage.percent}%`) +
							theme.fg("dim", `  ${fmtTokens(usage.tokens)}/${fmtTokens(usage.contextWindow)}`);
					} else {
						r2 = theme.fg("dim", "context n/a");
					}

					return [join(l1, r1, width), join(l2, r2, width)];
				},
			};
		});
	});

	const stop = () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};
	pi.on("session_shutdown", async () => stop());
}
