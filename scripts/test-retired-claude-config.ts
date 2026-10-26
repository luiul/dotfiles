#!/usr/bin/env bun
/** Pin the removal of Claude Code configs and Pi desktop notifications. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
let passed = 0;
function check(name: string, fn: () => void) {
	fn();
	passed++;
	console.log(`PASS: ${name}`);
}
const read = (path: string) => readFileSync(join(root, path), "utf8");

check("retired files are absent", () => {
	for (const path of [
		"claude",
		"Marketplacefile",
		"Pluginfile",
		"hellofresh/projects/hellofresh/CLAUDE.md",
		"pi/.pi/agent/extensions/notifications.ts",
		"scripts/test-pi-notifications.sh",
	]) assert.equal(existsSync(join(root, path)), false, path);
});
check("Brewfile does not install retired tooling", () => {
	assert.doesNotMatch(read("brew/Brewfile"), /mlz11\/tap|claude-notifier|anthropic\.claude-code/);
});
check("VS Code has no Claude Code settings", () => {
	assert.doesNotMatch(read("vscode/Library/Application Support/Code/User/settings.json"), /"claudeCode\./);
});
check("example environment has no Claude CLI model defaults", () => {
	assert.doesNotMatch(read("example.env"), /ANTHROPIC_DEFAULT_|Anthropic \/ Claude CLI/);
});
check("setup and hook do not invoke the Claude CLI", () => {
	assert.doesNotMatch(read("setup.sh"), /claude plugin|claude\.ai\/install/);
	assert.doesNotMatch(read(".githooks/pre-commit"), /claude plugin|Marketplacefile|Pluginfile/);
});
check("active docs have no removed config paths", () => {
	for (const file of ["README.md", "AGENTS.md", "pi/.pi/agent/AGENTS.md", "docs/glossary.md", "datagrip/README.md"]) {
		assert.doesNotMatch(read(file), /claude\/\.claude|claude\/settings|~\/\.claude|`claude`/, file);
	}
});
check("Pi model and dashboard configuration stays available", () => {
	assert.match(read("pi/.pi/agent/models.json"), /anthropic\.claude/);
	assert.match(read("canopy/.config/canopy/config.toml"), /agents = \["pi"\]/);
	assert.equal(existsSync(join(root, "orca/README.md")), true);
});

const sandbox = mkdtempSync(join(tmpdir(), "retired-claude-config-"));
try {
	const bin = join(sandbox, "bin");
	mkdirSync(bin);
	mkdirSync(join(sandbox, "brew"));
	const calls = join(sandbox, "calls");
	const executable = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
	executable("git", `
case "$1" in
	rev-parse) printf '%s\\n' "$MOCK_ROOT" ;;
	diff) printf '%s' "\${MOCK_STAGED:-}" ;;
	add) printf 'git add %s\\n' "$2" >> "$MOCK_CALLS" ;;
	*) exit 9 ;;
esac`);
	executable("brew", `
printf 'brew dump\\n' >> "$MOCK_CALLS"
cp "$MOCK_ROOT/installed.Brewfile" brew/Brewfile`);
	executable("claude", `printf 'unexpected Claude invocation\\n' >> "$MOCK_CALLS"; exit 9`);
	executable("gitleaks", `printf 'secret scan\\n' >> "$MOCK_CALLS"`);
	writeFileSync(join(sandbox, ".env"), [
		"# Anthropic / Claude CLI",
		...['HAIKU', 'SONNET', 'OPUS', 'FABLE'].map(name => `ANTHROPIC_DEFAULT_${name}_MODEL=retired-value`),
		"AWS_PROFILE=keep-value",
		"AI_MODEL_ROUTER_API_KEY=secret-value",
		"JIRA_API_TOKEN=another-value",
		"",
	].join("\n"));
	writeFileSync(join(sandbox, "installed.Brewfile"), [
		'tap "mlz11/tap"',
		'tap "stablyai/orca"',
		'# macOS notifications with Claude icon for Claude Code hooks',
		'cask "mlz11/tap/claude-notifier", trusted: true',
		'cask "stablyai/orca/orca", trusted: true',
		'brew "tmux"',
		'vscode "anthropic.claude-code"',
		'vscode "golang.go"',
		'npm "pi-hermes-memory"',
		"",
	].join("\n"));
	const run = (staged = "") => spawnSync("/bin/bash", [join(root, ".githooks/pre-commit")], {
		cwd: sandbox,
		encoding: "utf8",
		timeout: 10_000,
		env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, MOCK_ROOT: sandbox, MOCK_CALLS: calls, MOCK_STAGED: staged },
	});
	check("commit hook cannot restore retired configs from live installs", () => {
		const result = run();
		assert.equal(result.status, 0, result.stderr);
		const brewfile = readFileSync(join(sandbox, "brew/Brewfile"), "utf8");
		assert.doesNotMatch(brewfile, /claude|mlz11/i);
		for (const entry of ['tap "stablyai/orca"', 'cask "stablyai/orca/orca"', 'brew "tmux"', 'vscode "golang.go"', 'npm "pi-hermes-memory"']) assert.ok(brewfile.includes(entry), entry);
		const env = readFileSync(join(sandbox, "example.env"), "utf8");
		assert.doesNotMatch(env, /ANTHROPIC_DEFAULT_|Claude CLI|secret-value|another-value|keep-value/);
		for (const entry of ["AWS_PROFILE=", "AI_MODEL_ROUTER_API_KEY=", "JIRA_API_TOKEN="]) assert.ok(env.includes(entry), entry);
		assert.equal(existsSync(join(sandbox, "Marketplacefile")), false);
		assert.equal(existsSync(join(sandbox, "Pluginfile")), false);
		assert.equal(readFileSync(calls, "utf8"), "git add example.env\nbrew dump\ngit add brew/Brewfile\nsecret scan\n");
	});
	check("commit hook still blocks staged secrets", () => {
		writeFileSync(calls, "");
		const result = run(".env\n");
		assert.equal(result.status, 1);
		assert.match(result.stdout, /ERROR: \.env contains secrets/);
		assert.doesNotMatch(readFileSync(calls, "utf8"), /brew dump|secret scan|unexpected Claude/);
	});
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}
console.log(`\n${passed} checks passed.`);
