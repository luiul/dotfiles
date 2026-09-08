import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createNotifications,
	detectTerminal,
	formatDuration,
	isVsCodeFamily,
	osc99Notification,
	parseThreshold,
	pickChannel,
	shouldNotifyCompaction,
	type NotifyDeps,
} from "../notifications";

// --- Test harness -----------------------------------------------------------

interface ExecCall {
	file: string;
	args: string[];
}

function makeDeps(overrides: {
	env?: NodeJS.ProcessEnv;
	platform?: string;
	frontmost?: string;
	itermSession?: string;
	gitRoot?: string;
}) {
	const calls: ExecCall[] = [];
	const written: string[] = [];
	const deps: NotifyDeps = {
		env: overrides.env ?? {},
		platform: overrides.platform ?? "darwin",
		writeTerminal: (data) => {
			written.push(data);
		},
		exec: async (file, args) => {
			calls.push({ file, args });
			if (file === "osascript" && args[1]?.includes("frontmost")) return `${overrides.frontmost ?? ""}\n`;
			if (file === "osascript" && args[1]?.includes("iTerm2")) return `${overrides.itermSession ?? ""}\n`;
			if (file === "git") {
				if (overrides.gitRoot === undefined) throw new Error("not a git repo");
				return `${overrides.gitRoot}\n`;
			}
			return ""; // claude-notifier
		},
	};
	return {
		deps,
		calls,
		written,
		notifierCalls: () => calls.filter((c) => c.file === "claude-notifier"),
	};
}

function makePi() {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => unknown }>();
	const pi = {
		on: (event: string, handler: (event: any, ctx: any) => unknown) => handlers.set(event, handler),
		registerCommand: (name: string, def: { description: string; handler: (args: string, ctx: any) => unknown }) =>
			commands.set(name, def),
	};
	return { pi: pi as any, handlers, commands };
}

function makeCtx(overrides: { hasUI?: boolean; cwd?: string } = {}) {
	return {
		hasUI: overrides.hasUI ?? true,
		cwd: overrides.cwd ?? "/work/repo",
		ui: { notify: vi.fn() },
	} as any;
}

const VSCODE_ENV = { TERM_PROGRAM: "vscode", __CFBundleIdentifier: "com.microsoft.VSCode" } as NodeJS.ProcessEnv;

// --- Pure helpers -----------------------------------------------------------

describe("formatDuration", () => {
	it("formats seconds below a minute as-is", () => {
		expect(formatDuration(45)).toBe("45s");
		expect(formatDuration(59)).toBe("59s");
	});
	it("formats minutes", () => {
		expect(formatDuration(60)).toBe("1 minute");
		expect(formatDuration(120)).toBe("2 minutes");
		expect(formatDuration(600)).toBe("10 minutes");
		expect(formatDuration(1200)).toBe("20 minutes");
	});
});

describe("parseThreshold", () => {
	it("defaults to 600", () => {
		expect(parseThreshold(undefined)).toBe(600);
		expect(parseThreshold("")).toBe(600);
		expect(parseThreshold("abc")).toBe(600);
	});
	it("treats zero and negatives as unset", () => {
		expect(parseThreshold("0")).toBe(600);
		expect(parseThreshold("-5")).toBe(600);
	});
	it("accepts positive values", () => {
		expect(parseThreshold("120")).toBe(120);
	});
});

describe("shouldNotifyCompaction", () => {
	it("only notifies for manual compaction", () => {
		expect(shouldNotifyCompaction("manual")).toBe(true);
		expect(shouldNotifyCompaction("threshold")).toBe(false);
		expect(shouldNotifyCompaction("overflow")).toBe(false);
		expect(shouldNotifyCompaction(undefined)).toBe(false);
	});
});

describe("detectTerminal", () => {
	it("detects iTerm2 with session id", () => {
		const term = detectTerminal({ ITERM_SESSION_ID: "w0t0p1:abc123" } as NodeJS.ProcessEnv);
		expect(term.type).toBe("iterm2");
		expect(term.sessionId).toBe("w0t0p1:abc123");
	});
	it("detects VS Code and forks via bundle id", () => {
		expect(detectTerminal(VSCODE_ENV).type).toBe("vscode");
		expect(detectTerminal({ TERM_PROGRAM: "vscode", __CFBundleIdentifier: "com.todesktop.230313mzl4w4u92" } as NodeJS.ProcessEnv).type).toBe("cursor");
		expect(detectTerminal({ TERM_PROGRAM: "vscode", __CFBundleIdentifier: "com.vscodium" } as NodeJS.ProcessEnv).type).toBe("vscodium");
		expect(detectTerminal({ TERM_PROGRAM: "vscode", __CFBundleIdentifier: "com.exafunction.windsurf" } as NodeJS.ProcessEnv).type).toBe("windsurf");
	});
	it("detects ghostty and zed", () => {
		expect(detectTerminal({ TERM_PROGRAM: "ghostty" } as NodeJS.ProcessEnv).bundleId).toBe("com.mitchellh.ghostty");
		expect(detectTerminal({ TERM_PROGRAM: "zed" } as NodeJS.ProcessEnv).bundleId).toBe("dev.zed.Zed");
	});
	it("returns empty info for unknown terminals", () => {
		expect(detectTerminal({} as NodeJS.ProcessEnv)).toEqual({ type: "", label: "", bundleId: "", sessionId: "" });
	});
});

describe("isVsCodeFamily", () => {
	it("matches VS Code and its forks", () => {
		expect(isVsCodeFamily("vscode")).toBe(true);
		expect(isVsCodeFamily("cursor")).toBe(true);
		expect(isVsCodeFamily("vscodium")).toBe(true);
		expect(isVsCodeFamily("windsurf")).toBe(true);
	});
	it("rejects other terminals", () => {
		expect(isVsCodeFamily("ghostty")).toBe(false);
		expect(isVsCodeFamily("iterm2")).toBe(false);
		expect(isVsCodeFamily("")).toBe(false);
	});
});

describe("osc99Notification", () => {
	it("builds a two-chunk OSC 99 sequence", () => {
		expect(osc99Notification("pi · VS Code", "repo: Awaiting your input")).toBe(
			"\x1b]99;i=pi:d=0;pi · VS Code\x1b\\" + "\x1b]99;i=pi:p=body;repo: Awaiting your input\x1b\\",
		);
	});
	it("strips control characters that would break the sequence", () => {
		const seq = osc99Notification("bad\x1btitle", "line1\nline2");
		expect(seq).not.toContain("bad\x1btitle");
		expect(seq).toContain("line1 line2");
	});
});

// --- Channel selection ------------------------------------------------------

describe("pickChannel", () => {
	it("forces desktop regardless of focus", async () => {
		const { deps, calls } = makeDeps({ env: VSCODE_ENV, frontmost: "com.microsoft.VSCode" });
		expect(await pickChannel(detectTerminal(VSCODE_ENV), true, deps)).toBe("desktop");
		expect(calls).toHaveLength(0); // no focus lookup needed
	});
	it("notifies on desktop for unknown terminals", async () => {
		const { deps } = makeDeps({});
		expect(await pickChannel(detectTerminal({} as NodeJS.ProcessEnv), false, deps)).toBe("desktop");
	});
	it("notifies on desktop when the terminal app is not frontmost", async () => {
		const { deps } = makeDeps({ frontmost: "com.apple.Safari" });
		expect(await pickChannel(detectTerminal(VSCODE_ENV), false, deps)).toBe("desktop");
	});
	it("uses OSC 99 when a VS Code family editor is frontmost", async () => {
		const { deps } = makeDeps({ frontmost: "com.microsoft.VSCode" });
		expect(await pickChannel(detectTerminal(VSCODE_ENV), false, deps)).toBe("osc99");
	});
	it("suppresses when a non-VS Code terminal is frontmost", async () => {
		const env = { TERM_PROGRAM: "ghostty" } as NodeJS.ProcessEnv;
		const { deps } = makeDeps({ frontmost: "com.mitchellh.ghostty" });
		expect(await pickChannel(detectTerminal(env), false, deps)).toBe("none");
	});
	it("suppresses in iTerm2 only when the active session is ours", async () => {
		const env = { ITERM_SESSION_ID: "w0t0p1:mine" } as NodeJS.ProcessEnv;
		const same = makeDeps({ frontmost: "com.googlecode.iterm2", itermSession: "mine" });
		expect(await pickChannel(detectTerminal(env), false, same.deps)).toBe("none");
		const other = makeDeps({ frontmost: "com.googlecode.iterm2", itermSession: "other" });
		expect(await pickChannel(detectTerminal(env), false, other.deps)).toBe("desktop");
	});
});

// --- Extension wiring -------------------------------------------------------

describe("notifications extension", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function setup(depsOverrides: Parameters<typeof makeDeps>[0], env: NodeJS.ProcessEnv) {
		const harness = makeDeps({ ...depsOverrides, env });
		const { pi, handlers, commands } = makePi();
		createNotifications(harness.deps)(pi);
		return { ...harness, handlers, commands };
	}

	it("does not register for agent_end (agent_settled is the correct trigger)", () => {
		const { handlers } = setup({}, VSCODE_ENV);
		expect(handlers.has("agent_end")).toBe(false);
		expect(handlers.has("agent_settled")).toBe(true);
	});

	it("never notifies without a UI (subagent child sessions, print mode)", async () => {
		const { handlers, calls, written } = setup({ frontmost: "com.apple.Safari" }, VSCODE_ENV);
		const ctx = makeCtx({ hasUI: false });
		await handlers.get("agent_settled")!({}, ctx);
		await handlers.get("session_compact")!({ reason: "manual" }, ctx);
		await handlers.get("agent_start")!({}, ctx);
		await vi.advanceTimersByTimeAsync(1200_000);
		expect(calls).toHaveLength(0);
		expect(written).toHaveLength(0);
	});

	it("sends a desktop notification when the terminal app is not frontmost", async () => {
		const { handlers, notifierCalls } = setup({ frontmost: "com.apple.Safari", gitRoot: "/work/dotfiles" }, VSCODE_ENV);
		await handlers.get("agent_settled")!({}, makeCtx());
		expect(notifierCalls()).toHaveLength(1);
		const args = notifierCalls()[0].args;
		expect(args).toContain("-T");
		expect(args[args.indexOf("-T") + 1]).toBe("vscode");
		expect(args[args.indexOf("-t") + 1]).toBe("pi · VS Code");
		expect(args[args.indexOf("-s") + 1]).toBe("dotfiles");
		expect(args[args.indexOf("-m") + 1]).toBe("Awaiting your input");
	});

	it("sends an in-product OSC 99 notification when VS Code is frontmost", async () => {
		const { handlers, notifierCalls, written } = setup(
			{ frontmost: "com.microsoft.VSCode", gitRoot: "/work/dotfiles" },
			VSCODE_ENV,
		);
		await handlers.get("agent_settled")!({}, makeCtx());
		expect(notifierCalls()).toHaveLength(0);
		expect(written).toHaveLength(1);
		expect(written[0]).toContain("]99;");
		expect(written[0]).toContain("pi · VS Code");
		expect(written[0]).toContain("dotfiles: Awaiting your input");
	});

	it("stays silent when a non-VS Code terminal is frontmost", async () => {
		const env = { TERM_PROGRAM: "ghostty" } as NodeJS.ProcessEnv;
		const { handlers, calls, written } = setup({ frontmost: "com.mitchellh.ghostty" }, env);
		await handlers.get("agent_settled")!({}, makeCtx());
		expect(calls.filter((c) => c.file === "claude-notifier")).toHaveLength(0);
		expect(written).toHaveLength(0);
	});

	it("falls back to the cwd basename when git fails", async () => {
		const { handlers, notifierCalls } = setup({ frontmost: "com.apple.Safari" }, VSCODE_ENV);
		await handlers.get("agent_settled")!({}, makeCtx({ cwd: "/work/myrepo" }));
		const args = notifierCalls()[0].args;
		expect(args[args.indexOf("-s") + 1]).toBe("myrepo");
	});

	it("notifies only for manual compaction", async () => {
		const { handlers, notifierCalls } = setup({ frontmost: "com.apple.Safari" }, VSCODE_ENV);
		const ctx = makeCtx();
		await handlers.get("session_compact")!({ reason: "threshold" }, ctx);
		await handlers.get("session_compact")!({ reason: "overflow", willRetry: true }, ctx);
		expect(notifierCalls()).toHaveLength(0);
		await handlers.get("session_compact")!({ reason: "manual" }, ctx);
		expect(notifierCalls()).toHaveLength(1);
		expect(notifierCalls()[0].args).toContain("Context compacted");
	});

	it("alerts every 600s by default while a run is active and stops on settle", async () => {
		const { handlers, notifierCalls } = setup({ frontmost: "com.apple.Safari" }, VSCODE_ENV);
		const ctx = makeCtx();
		await handlers.get("agent_start")!({}, ctx);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(notifierCalls()).toHaveLength(1);
		expect(notifierCalls()[0].args).toContain("Still working for 10 minutes without a result");
		await vi.advanceTimersByTimeAsync(600_000);
		expect(notifierCalls()).toHaveLength(2);
		expect(notifierCalls()[1].args).toContain("Still working for 20 minutes without a result");
		await handlers.get("agent_settled")!({}, ctx);
		expect(notifierCalls()).toHaveLength(3); // the settled notification
		await vi.advanceTimersByTimeAsync(1200_000);
		expect(notifierCalls()).toHaveLength(3); // watcher stopped
	});

	it("stops the watcher on session shutdown", async () => {
		const { handlers, notifierCalls } = setup({ frontmost: "com.apple.Safari" }, VSCODE_ENV);
		await handlers.get("agent_start")!({}, makeCtx());
		await handlers.get("session_shutdown")!({}, makeCtx());
		await vi.advanceTimersByTimeAsync(1200_000);
		expect(notifierCalls()).toHaveLength(0);
	});

	it("toggles notifications with /notifications", async () => {
		const { handlers, commands, notifierCalls } = setup({ frontmost: "com.apple.Safari" }, VSCODE_ENV);
		const ctx = makeCtx();
		await commands.get("notifications")!.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Notifications disabled", "info");
		await handlers.get("agent_settled")!({}, ctx);
		expect(notifierCalls()).toHaveLength(0);
		await commands.get("notifications")!.handler("", ctx);
		await handlers.get("agent_settled")!({}, ctx);
		expect(notifierCalls()).toHaveLength(1);
	});

	it("refuses to enable on non-macOS platforms", async () => {
		const { handlers, commands, notifierCalls } = setup({ platform: "linux", frontmost: "" }, VSCODE_ENV);
		const ctx = makeCtx();
		await commands.get("notifications")!.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Notifications are only supported on macOS", "warning");
		await handlers.get("agent_settled")!({}, ctx);
		expect(notifierCalls()).toHaveLength(0);
	});

	it("shows and sets the long-run threshold with /notify-timeout", async () => {
		const { handlers, commands, notifierCalls } = setup({ frontmost: "com.apple.Safari" }, VSCODE_ENV);
		const ctx = makeCtx();
		await commands.get("notify-timeout")!.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Long-running alert fires every 10 minutes", "info");
		await commands.get("notify-timeout")!.handler("120", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Long-running alert set to 2 minutes (applies to next run)", "info");
		await handlers.get("agent_start")!({}, ctx);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(notifierCalls()[0].args).toContain("Still working for 2 minutes without a result");
		await commands.get("notify-timeout")!.handler("abc", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /notify-timeout <seconds> (>= 0)", "warning");
	});

	it("disables the watcher with /notify-timeout 0", async () => {
		const { handlers, commands, notifierCalls } = setup({ frontmost: "com.apple.Safari" }, VSCODE_ENV);
		const ctx = makeCtx();
		await commands.get("notify-timeout")!.handler("0", ctx);
		await handlers.get("agent_start")!({}, ctx);
		await vi.advanceTimersByTimeAsync(1200_000);
		expect(notifierCalls()).toHaveLength(0);
	});
});
