import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** GUI launchers can start Pi without the login shell's key or managed PATH. */
export async function restoreGuiEnvironment(
	pi: Pick<ExtensionAPI, "exec">,
	env: NodeJS.ProcessEnv = process.env,
	platform = process.platform,
	agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
	execPath = process.execPath,
	dotfilesEnv = join(homedir(), "dotfiles", ".env"),
): Promise<void> {
	const piBin = join(env.PI_MANAGED_INSTALL_ROOT ? dirname(env.PI_MANAGED_INSTALL_ROOT) : agentDir, "bin");
	try {
		if (platform === "win32") throw new Error("Managed POSIX launcher only");
		accessSync(join(piBin, "pi"), constants.X_OK);
		const paths = (env.PATH ?? "").split(":").filter(Boolean);
		for (const directory of [piBin, dirname(execPath)].reverse()) {
			if (!paths.includes(directory)) paths.unshift(directory);
		}
		env.PATH = paths.join(":");
	} catch {
		// Do not point child processes at an absent managed installation.
	}

	if (platform !== "darwin" || env.AI_MODEL_ROUTER_API_KEY?.trim()) return;
	// Never replace an inherited key, persist credentials, or print output.
	try {
		const result = await pi.exec("/bin/launchctl", ["getenv", "AI_MODEL_ROUTER_API_KEY"], { timeout: 2000 });
		if (result.code === 0 && !result.killed && !result.truncated) {
			const key = result.stdout.trim();
			if (key && !env.AI_MODEL_ROUTER_API_KEY?.trim()) env.AI_MODEL_ROUTER_API_KEY = key;
		}
	} catch {}
	if (env.AI_MODEL_ROUTER_API_KEY?.trim()) return;
	// tmux can use a bootstrap namespace without the GUI key. Read only the
	// canonical user's dotenv file, never cwd or a worktree, without shell code.
	try {
		const key = parseEnv(readFileSync(dotfilesEnv, "utf8")).AI_MODEL_ROUTER_API_KEY?.trim();
		if (key) env.AI_MODEL_ROUTER_API_KEY = key;
	} catch {
		// Keep normal provider errors when neither trusted source has a key.
	}
}

export default async function (_pi: ExtensionAPI) {
	// Factory completion precedes model selection. pi.exec is not bound yet.
	await restoreGuiEnvironment({
		exec: (command, args, options) => new Promise((resolve) => {
			execFile(command, args, { timeout: options?.timeout, maxBuffer: 16 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
				resolve({ code: error ? 1 : 0, stdout, stderr, killed: Boolean(error?.killed) });
			});
		}),
	});
}
