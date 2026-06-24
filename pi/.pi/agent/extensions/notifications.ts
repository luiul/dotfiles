/**
 * System notifications for pi (mirrors the Claude Code notifier setup).
 *
 * Fires a macOS notification via the `claude-notifier` binary when pi finishes
 * a turn and hands control back to you, after a context compaction, or when a
 * single agent run has been working for too long without returning control
 * (default 300s, configurable via PI_LONG_RUN_SECONDS or /notify-timeout). The
 * notification is suppressed when you are already looking at pi's terminal tab,
 * replicating the focus-detection logic from the Claude `notify.sh` hook.
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

interface TermInfo {
	type: string;
	label: string;
	bundleId: string;
	sessionId: string;
}

// Map the current terminal (from env) to claude-notifier's terminal types so it
// can focus the right tab on click, mirroring notify.sh's detect_terminal.
function detectTerminal(): TermInfo {
	const env = process.env;
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

async function frontmostBundleId(): Promise<string> {
	try {
		const { stdout } = await execFileAsync(
			"osascript",
			["-e", "tell application \"System Events\" to get bundle identifier of first process whose frontmost is true"],
			{ timeout: 2000 },
		);
		return stdout.trim();
	} catch {
		return "";
	}
}

// Decide whether to notify: skip only when pi's own terminal tab is focused.
async function shouldNotify(term: TermInfo): Promise<boolean> {
	if (!term.bundleId) return true; // unknown terminal, always notify
	if ((await frontmostBundleId()) !== term.bundleId) return true; // app not focused

	// App is focused. For iTerm2 we can still tell tabs apart, so only suppress
	// when the active session matches ours; other terminals suppress outright.
	if (term.type === "iterm2") {
		const mine = term.sessionId.split(":").pop() ?? "";
		try {
			const { stdout } = await execFileAsync(
				"osascript",
				["-e", "tell application \"iTerm2\" to tell current session of current window to return id"],
				{ timeout: 2000 },
			);
			return mine !== stdout.trim();
		} catch {
			return false;
		}
	}
	return false;
}

async function repoName(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 2000 });
		return basename(stdout.trim());
	} catch {
		return basename(cwd);
	}
}

// Seconds an agent run may work before we alert. <= 0 disables the watcher.
function parseThreshold(): number {
	const raw = Number(process.env.PI_LONG_RUN_SECONDS);
	return Number.isFinite(raw) && raw > 0 ? raw : 300;
}

export default function (pi: ExtensionAPI) {
	let enabled = process.platform === "darwin";
	let longRunThreshold = parseThreshold();
	let longRunTimer: ReturnType<typeof setInterval> | undefined;

	const stopLongRunWatch = () => {
		if (longRunTimer) {
			clearInterval(longRunTimer);
			longRunTimer = undefined;
		}
	};

	const maybeNotify = async (ctx: ExtensionContext, message: string, force = false) => {
		if (!enabled) return;
		try {
			const term = detectTerminal();
			if (!force && !(await shouldNotify(term))) return;
			const repo = await repoName(ctx.cwd);
			const title = term.label ? `pi · ${term.label}` : "pi";
			await execFileAsync(NOTIFIER, [
				"-t", title,
				"-s", repo,
				"-m", message,
				"-i", term.sessionId,
				"-T", term.type,
				"-S", SOUND,
			]);
		} catch {
			// Never let a notification failure disrupt the session.
		}
	};

	// Start a repeating watcher per agent run; alert at each threshold boundary
	// while pi keeps working, reporting cumulative elapsed time.
	pi.on("agent_start", async (_event, ctx) => {
		stopLongRunWatch();
		if (!enabled || longRunThreshold <= 0) return;
		const startedAt = Date.now();
		longRunTimer = setInterval(() => {
			const elapsed = Math.round((Date.now() - startedAt) / 1000);
			void maybeNotify(ctx, `Still working after ${elapsed}s without a result`, true);
		}, longRunThreshold * 1000);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stopLongRunWatch();
		await maybeNotify(ctx, "Awaiting your input");
	});

	pi.on("session_shutdown", async () => {
		stopLongRunWatch();
	});

	pi.on("session_compact", async (_event, ctx) => {
		await maybeNotify(ctx, "Context compacted");
	});

	pi.registerCommand("notifications", {
		description: "Toggle macOS notifications on/off",
		handler: async (_args, ctx) => {
			if (process.platform !== "darwin") {
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
						? `Long-running alert fires every ${longRunThreshold}s`
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
					? `Long-running alert set to ${longRunThreshold}s (applies to next run)`
					: "Long-running alert disabled",
				"info",
			);
		},
	});
}
