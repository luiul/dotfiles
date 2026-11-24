/** Bound context-mode execution and reject an unverified lifecycle patch. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import approved from "../patches/context-mode/approved-files.json";

export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const EXEC_TOOLS = new Set(["ctx_execute", "ctx_execute_file", "ctx_batch_execute"]);
const PATCH_VERSION = approved.version;

export function verifyResourcePatch(packageDir: string): string | undefined {
	try {
		const root = realpathSync(packageDir);
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const manifest = JSON.parse(readFileSync(join(root, ".pi-resource-patch.json"), "utf8"));
		if (pkg.name !== "context-mode" || pkg.version !== PATCH_VERSION || manifest.version !== PATCH_VERSION || manifest.revision !== approved.revision || manifest.patchVersion !== 1) {
			return "context-mode resource patch version does not match";
		}
		// The package marker cannot approve its own replacement bytes.
		for (const [file, expected] of Object.entries(approved.files)) {
			if (manifest.files?.[file] !== expected) return `context-mode patch does not match reviewed ${file}`;
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
	const check = () => verifyResourcePatch(packageDir);
	pi.on("session_start", async (_event, ctx) => {
		const error = check();
		if (error) {
			if (ctx.hasUI) ctx.ui.notify(`${error}. Run pi-resources-patch, then /reload.`, "warning");
		}
	});
	pi.on("tool_call", async (event) => {
		if (!event.toolName.startsWith("ctx_")) return;
		// A package update or bridge respawn can happen during a long run.
		// Recheck bytes before every ctx call, not only at the run boundary.
		const patchError = check();
		if (patchError) return { block: true, reason: `${patchError}. Run pi-resources-patch, then /reload.` };
		const error = enforceExecutionBudget(event.toolName, event.input as Record<string, unknown>);
		if (error) return { block: true, reason: error };
	});
}
