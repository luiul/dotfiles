/**
 * System notifications for pi (mirrors the Claude Code notifier setup).
 *
 * Fires a macOS notification via the `claude-notifier` binary when pi settles
 * and hands control back to you, after a manual context compaction, or when a
 * single agent run has been working for too long without returning control
 * (default 600s, configurable via PI_LONG_RUN_SECONDS or /notify-timeout).
 *
 * The desktop notification is suppressed when you are already looking at pi's
 * terminal app. In the VS Code integrated terminal (and its forks) an
 * in-product OSC 99 notification is sent instead of staying silent, because
 * VS Code is often frontmost while pi runs in a hidden panel or another
 * window. Clicking it focuses the terminal. This needs VS Code's default
 * `terminal.integrated.enableNotifications` setting (true since early 2026).
 *
 * Only interactive sessions notify: subagent child sessions and print mode
 * (`ctx.hasUI === false`) never fire. `agent_settled` is used instead of
 * `agent_end`, which can fire before auto-retries, auto-compaction retries,
 * or queued follow-up messages.
 *
 * Toggle notifications on and off with the /notifications command.
 */

import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const NOTIFIER = "claude-notifier";
const SOUND = "default";
const DEFAULT_LONG_RUN_SECONDS = 600;

export interface TermInfo {
	type: string;
	label: string;
	bundleId: string;
	sessionId: string;
}

/** Side effects, injectable for tests. */
export interface NotifyDeps {
	exec: (file: string, args: string[], options: { cwd?: string; timeout?: number }) => Promise<string>;
	writeTerminal: (data: string) => void;
	env: NodeJS.ProcessEnv;
	platform: string;
}

// Map the current terminal (from env) to claude-notifier's terminal types so it
// can focus the right tab on click, mirroring notify.sh's detect_terminal.
export function detectTerminal(env: NodeJS.ProcessEnv): TermInfo {
	const bundle = env.__CFBundleIdentifier ?? "";

	if (env.ITERM_SESSION_ID) {
		return {
			type: "iterm2",
			label: "iTerm2",
			bundleId: "com.googlecode.iterm2",
			sessionId: env.ITERM_SESSION_ID,
		};
	}
	switch (env.TERM_PROGRAM) {
		case "Apple_Terminal":
			return { type: "terminal", label: "Terminal", bundleId: "com.apple.Terminal", sessionId: "" };
		case "ghostty":
			return { type: "ghostty", label: "Ghostty", bundleId: "com.mitchellh.ghostty", sessionId: "" };
		case "WarpTerminal":
			return { type: "warp", label: "Warp", bundleId: "dev.warp.Warp-Stable", sessionId: "" };
		case "zed":
			return { type: "zed", label: "Zed", bundleId: "dev.zed.Zed", sessionId: "" };
		case "vscode":
			switch (bundle) {
				case "com.todesktop.230313mzl4w4u92":
					return { type: "cursor", label: "Cursor", bundleId: bundle, sessionId: "" };
				case "com.vscodium":
					return { type: "vscodium", label: "VSCodium", bundleId: bundle, sessionId: "" };
				case "com.exafunction.windsurf":
					return { type: "windsurf", label: "Windsurf", bundleId: bundle, sessionId: "" };
				default:
					return { type: "vscode", label: "VS Code", bundleId: "com.microsoft.VSCode", sessionId: "" };
			}
	}
	return { type: "", label: "", bundleId: "", sessionId: "" };
}

export function isVsCodeFamily(type: string): boolean {
	return type === "vscode" || type === "cursor" || type === "vscodium" || type === "windsurf";
}

// Human-readable elapsed time for notification text: "45s", "1 minute",
// "10 minutes".
export function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

// Seconds an agent run may work before we alert. <= 0 or unparsable falls back
// to the default. /notify-timeout 0 disables at runtime, the env var cannot.
export function parseThreshold(raw: string | undefined): number {
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_LONG_RUN_SECONDS;
}

// Only manual /compact is worth a notification. Threshold and overflow
// compactions happen mid-run and the agent keeps working afterwards.
export function shouldNotifyCompaction(reason: string | undefined): boolean {
	return reason === "manual";
}

// Kitty desktop notification protocol (OSC 99), which VS Code shows as an
// in-product notification that focuses the terminal on click. Two chunks:
// title first, body second. Control characters would break the sequence.
export function osc99Notification(title: string, body: string): string {
	const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]/g, " ").trim();
	return `\x1b]99;i=pi:d=0;${clean(title)}\x1b\\` + `\x1b]99;i=pi:p=body;${clean(body)}\x1b\\`;
}

export type NotifyChannel = "desktop" | "osc99" | "none";

async function frontmostBundleId(deps: NotifyDeps): Promise<string> {
	try {
		return (
			await deps.exec(
				"osascript",
				["-e", 'tell application "System Events" to get bundle identifier of first process whose frontmost is true'],
				{ timeout: 2000 },
			)
		).trim();
	} catch {
		return "";
	}
}

async function isItermSessionActive(term: TermInfo, deps: NotifyDeps): Promise<boolean> {
	const mine = term.sessionId.split(":").pop() ?? "";
	try {
		const active = await deps.exec(
			"osascript",
			["-e", 'tell application "iTerm2" to tell current session of current window to return id'],
			{ timeout: 2000 },
		);
		return mine === active.trim();
	} catch {
		return true; // cannot tell tabs apart, stay silent
	}
}

// Decide where a notification goes: desktop via claude-notifier, in-product
// OSC 99 for a frontmost VS Code family editor, or nowhere when you are
// already looking at pi. `force` (long-run watcher) always goes desktop.
export async function pickChannel(term: TermInfo, force: boolean, deps: NotifyDeps): Promise<NotifyChannel> {
	if (force) return "desktop";
	if (!term.bundleId) return "desktop"; // unknown terminal, always notify
	if ((await frontmostBundleId(deps)) !== term.bundleId) return "desktop"; // app not focused

	// App is focused. iTerm2 can tell tabs apart, so only suppress when the
	// active session is ours. VS Code family gets an in-product notification,
	// since a frontmost editor often hides the terminal panel. Other terminals
	// suppress outright.
	if (term.type === "iterm2") {
		return (await isItermSessionActive(term, deps)) ? "none" : "desktop";
	}
	if (isVsCodeFamily(term.type)) return "osc99";
	return "none";
}

async function repoName(cwd: string, deps: NotifyDeps): Promise<string> {
	try {
		return basename((await deps.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 2000 })).trim());
	} catch {
		return basename(cwd);
	}
}

export function createNotifications(deps: NotifyDeps) {
	return function notifications(pi: ExtensionAPI) {
		let enabled = deps.platform === "darwin";
		let longRunThreshold = parseThreshold(deps.env.PI_LONG_RUN_SECONDS);
		let longRunTimer: ReturnType<typeof setInterval> | undefined;

		const stopLongRunWatch = () => {
			if (longRunTimer) {
				clearInterval(longRunTimer);
				longRunTimer = undefined;
			}
		};

		const maybeNotify = async (ctx: ExtensionContext, message: string, force = false) => {
			if (!enabled || !ctx.hasUI) return;
			try {
				const term = detectTerminal(deps.env);
				const channel = await pickChannel(term, force, deps);
				if (channel === "none") return;
				const repo = await repoName(ctx.cwd, deps);
				const title = term.label ? `pi · ${term.label}` : "pi";
				if (channel === "osc99") {
					deps.writeTerminal(osc99Notification(title, `${repo}: ${message}`));
					return;
				}
				await deps.exec(NOTIFIER, [
					"-t", title,
					"-s", repo,
					"-m", message,
					"-i", term.sessionId,
					"-T", term.type,
					"-S", SOUND,
				], {});
			} catch {
				// Never let a notification failure disrupt the session.
			}
		};

		// Start a repeating watcher per agent run; alert at each threshold boundary
		// while pi keeps working, reporting cumulative elapsed time.
		pi.on("agent_start", async (_event, ctx) => {
			stopLongRunWatch();
			if (!enabled || longRunThreshold <= 0 || !ctx.hasUI) return;
			const startedAt = Date.now();
			longRunTimer = setInterval(() => {
				const elapsed = Math.round((Date.now() - startedAt) / 1000);
				void maybeNotify(ctx, `Still working for ${formatDuration(elapsed)} without a result`, true);
			}, longRunThreshold * 1000);
		});

		// agent_end can fire before auto-retries, auto-compaction retries, or
		// queued follow-ups. agent_settled means pi will not continue on its own.
		pi.on("agent_settled", async (_event, ctx) => {
			stopLongRunWatch();
			await maybeNotify(ctx, "Awaiting your input");
		});

		pi.on("session_shutdown", async () => {
			stopLongRunWatch();
		});

		pi.on("session_compact", async (event, ctx) => {
			if (!shouldNotifyCompaction(event.reason)) return;
			await maybeNotify(ctx, "Context compacted");
		});

		pi.registerCommand("notifications", {
			description: "Toggle macOS notifications on/off",
			handler: async (_args, ctx) => {
				if (deps.platform !== "darwin") {
					ctx.ui.notify("Notifications are only supported on macOS", "warning");
					return;
				}
				enabled = !enabled;
				if (!enabled) stopLongRunWatch();
				ctx.ui.notify(enabled ? "Notifications enabled" : "Notifications disabled", "info");
			},
		});

		pi.registerCommand("notify-timeout", {
			description: "Set/show the long-running alert threshold in seconds (0 disables)",
			handler: async (args, ctx) => {
				const trimmed = args.trim();
				if (!trimmed) {
					ctx.ui.notify(
						longRunThreshold > 0
							? `Long-running alert fires every ${formatDuration(longRunThreshold)}`
							: "Long-running alert disabled",
						"info",
					);
					return;
				}
				const next = Number(trimmed);
				if (!Number.isFinite(next) || next < 0) {
					ctx.ui.notify("Usage: /notify-timeout <seconds> (>= 0)", "warning");
					return;
				}
				longRunThreshold = Math.round(next);
				stopLongRunWatch();
				ctx.ui.notify(
					longRunThreshold > 0
						? `Long-running alert set to ${formatDuration(longRunThreshold)} (applies to next run)`
						: "Long-running alert disabled",
					"info",
				);
			},
		});
	};
}

const realDeps: NotifyDeps = {
	exec: async (file, args, options) => (await execFileAsync(file, args, options)).stdout,
	writeTerminal: (data) => process.stdout.write(data),
	env: process.env,
	platform: process.platform,
};

export default createNotifications(realDeps);
