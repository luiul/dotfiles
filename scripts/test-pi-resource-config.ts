import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const home = homedir();
const dir = mkdtempSync(join(tmpdir(), "pi-resource-config-"));
try {
	const root = join(home, ".pi", "agent");
	const config = JSON.parse(readFileSync(join(root, "subagents.json"), "utf8"));
	// Load the installed parser through the real Pi host's extension module resolver.
	const managed = join(home, ".pi/agent/install");
	const modules = join(managed, "releases", readFileSync(join(managed, "current-version"), "utf8").trim(), "node_modules");
	const { createJiti } = await import(join(modules, "jiti/lib/jiti.mjs"));
	const jiti = createJiti(import.meta.url, {
		alias: { "@earendil-works/pi-coding-agent": join(modules, "@earendil-works/pi-coding-agent/dist/index.js") },
	});
	const { loadSettings } = await jiti.import(join(root, "npm/node_modules/@tintinweb/pi-subagents/src/settings.ts"));
	const loaded = loadSettings(dir);
	const candidate = JSON.parse(readFileSync(join(import.meta.dir, "../pi/.pi/agent/subagents.json"), "utf8"));
	assert.equal(candidate.worktreeIsolation, false, "Package-managed worktrees must not bypass wt or commit approval");
	mkdirSync(join(dir, ".pi"));
	writeFileSync(join(dir, ".pi/subagents.json"), JSON.stringify(candidate));
	assert.equal(loadSettings(dir).worktreeIsolation, false, "Installed parser honors the reviewed isolation setting");
	console.log("PASS candidate parser disables package-managed isolation without changing live settings");
	for (const [key, expected] of Object.entries({ maxConcurrent: 3, maxConcurrentForeground: 2, defaultMaxTurns: 60, graceTurns: 3, workflowsEnabled: false })) {
		assert.equal(config[key], expected); assert.equal(loaded[key], expected); console.log(`PASS installed parser ${key}=${expected}`);
	}
	const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
	assert.ok(settings.packages.includes("npm:context-mode@1.0.169"));
	assert.ok(settings.extensions.includes("-builtin:mcp"));
	const mcp = JSON.parse(readFileSync(join(root, "mcp-adapter.json"), "utf8"));
	assert.equal(mcp.settings.idleTimeout, 10);
	for (const server of Object.values(mcp.mcpServers) as any[]) {
		assert.equal(server.directTools, false);
		assert.notEqual(server.lifecycle, "eager");
	}
	const snapshot = JSON.parse(readFileSync(join(import.meta.dir, "../pi/.pi/agent/settings.json"), "utf8"));
	// Runtime changelog markers and session defaults are not reviewed configuration.
	// The model workstream owns live scope and model pin changes separately.
	const parallelOrRuntimeKeys = new Set(["defaultModel", "enabledModels", "defaultThinkingLevel", "modelThinkingLevels", "lastChangelogVersion", "extensionChangelogVersions"]);
	const stableSettings = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !parallelOrRuntimeKeys.has(key)));
	assert.deepEqual(stableSettings(settings), stableSettings(snapshot));
	assert.equal(readFileSync(join(root, "npm/package.json"), "utf8"), readFileSync(join(import.meta.dir, "../pi/.pi/agent/npm/package.json"), "utf8"));
	console.log("ALL PASS candidate isolation, live resource configuration, and scoped package snapshot checks");
} finally { rmSync(dir, { recursive: true, force: true }); }
