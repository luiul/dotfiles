/** Bound context-mode execution and reject an unverified lifecycle patch. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const EXEC_TOOLS = new Set(["ctx_execute", "ctx_execute_file", "ctx_batch_execute"]);
const PATCH_VERSION = "1.0.169";

export function verifyResourcePatch(packageDir: string): string | undefined {
	try {
		const root = realpathSync(packageDir);
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const manifest = JSON.parse(readFileSync(join(root, ".pi-resource-patch.json"), "utf8"));
		if (pkg.version !== PATCH_VERSION || manifest.version !== PATCH_VERSION || manifest.revision !== "context-mode-resources-v1" || manifest.patchVersion !== 1) {
			return "context-mode resource patch version does not match";
		}
		const required = ["build/adapters/pi/mcp-bridge.js", "build/executor.js", "build/server.js", "build/lifecycle.js", "server.bundle.mjs"];
		for (const file of required) {
			const expected = manifest.files?.[file];
			if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) return `context-mode patch lacks ${file}`;
			const path = realpathSync(resolve(root, file));
			if (!path.startsWith(root + sep)) return "context-mode patch path escapes package";
			const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
			if (hash !== expected) return `context-mode patch drift in ${file}`;
		}
	} catch {
		return "context-mode resource patch is missing or unreadable";
	}
	return undefined;
}

export function enforceExecutionBudget(name: string, input: Record<string, unknown>): string | undefined {
	if (!EXEC_TOOLS.has(name)) return undefined;
	if (input.background === true && input.timeout === undefined) {
		return "Background execution needs an explicit timeout and a shutdown step.";
	}
	if (input.timeout === undefined) input.timeout = DEFAULT_EXEC_TIMEOUT_MS;
	if (typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > 2_147_473_647) {
		return "Execution timeout must be a finite positive number below the timer limit.";
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const packageDir = join(agentDir, "npm", "node_modules", "context-mode");
	let patchError: string | undefined;
	let verified = false;
	const check = () => {
		patchError = verifyResourcePatch(packageDir);
		verified = true;
		return patchError;
	};
	pi.on("session_start", async (_event, ctx) => {
		const error = check();
		if (error) {
			pi.logger?.warn?.(`[resource-budget] ${error}. Run pi-resources-patch, then /reload.`);
			if (ctx.hasUI) ctx.ui.notify(`${error}. Run pi-resources-patch, then /reload.`, "warning");
		}
	});
	pi.on("before_agent_start", async () => { check(); });
	pi.on("tool_call", async (event) => {
		if (!event.toolName.startsWith("ctx_")) return;
		if (!verified) check();
		if (patchError) return { block: true, reason: `${patchError}. Run pi-resources-patch, then /reload.` };
		const error = enforceExecutionBudget(event.toolName, event.input as Record<string, unknown>);
		if (error) return { block: true, reason: error };
	});
}
