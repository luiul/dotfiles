import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const home = homedir();
const dir = mkdtempSync(join(tmpdir(), "pi-resource-config-"));
try {
	const root = join(home, ".pi", "agent");
	const config = JSON.parse(readFileSync(join(root, "subagents.json"), "utf8"));
	// Load the installed parser through the real Pi host's extension module resolver.
	const { createJiti } = await import(join(home, ".pi/agent/install/releases/1.4.0/node_modules/jiti/lib/jiti.mjs"));
	const jiti = createJiti(import.meta.url, {
		alias: { "@earendil-works/pi-coding-agent": join(home, ".pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js") },
	});
	const { loadSettings } = await jiti.import(join(root, "npm/node_modules/@tintinweb/pi-subagents/src/settings.ts"));
	const loaded = loadSettings(dir);
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
	for (const file of ["settings.json", "npm/package.json"]) {
		assert.equal(readFileSync(join(root, file), "utf8"), readFileSync(join(import.meta.dir, "../pi/.pi/agent", file), "utf8"));
	}
	console.log("ALL PASS live resource configuration and snapshots");
} finally { rmSync(dir, { recursive: true, force: true }); }
