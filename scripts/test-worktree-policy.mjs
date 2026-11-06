#!/usr/bin/env node
// Keep ordinary approval and worktree protections without the removed guard.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = file => fs.readFileSync(path.join(root, file), 'utf8');
const global = text('pi/.pi/agent/AGENTS.md');
const repo = text('AGENTS.md');
const hf = text('hellofresh/projects/hellofresh/AGENTS.md');
const wt = text('worktrunk/.config/worktrunk/config.toml');
const guide = text('docs/dev-setup-overview.md');
let count = 0;
function check(value, label) { assert.ok(value, label); console.log(`PASS ${++count}: ${label}`); }
for (const file of ['git/.local/bin/repo-guard', 'pi/.pi/agent/extensions/work-completion.ts', 'scripts/test-repo-guard.mjs', 'scripts/test-work-completion.ts', 'scripts/test-work-completion-live.mjs', 'scripts/fixtures/work-completion-live.ts']) {
 check(!fs.existsSync(path.join(root, file)), `removed ${file}`);
}
check([global,repo,hf,wt,guide,text('pi/.pi/agent/extensions/README.md')].every(s => !/repo-guard|work-completion|\/work-status/.test(s)), 'active instructions contain no removed guard references');
check(global.includes('Do not stage or commit on your own') && global.includes('Run `git add` and `git commit` only after the user approves'), 'commit approval remains');
check(global.includes('Plan approval permits implementation, not staging, committing, or pushing.'), 'planning approval does not permit publication');
check(global.includes('Parallel agents use separate source worktrees'), 'parallel worktrees remain');
check(global.includes('Never use mixed or soft reset'), 'unsafe live shortcuts remain forbidden');
check(hf.includes('push the ticket branch and create a draft PR'), 'HelloFresh publication remains ticket branches and draft PRs');
check(global.includes('Never force-push'), 'no force publication');
const preSwitch = wt.split('[pre-switch]')[1]?.split('[step.copy-ignored]')[0] ?? '';
check(preSwitch.includes('git fetch') && !/git[^\n]*(?:merge|reset|update-ref)/.test(preSwitch), 'creation remains fetch-only');
const preRemove = wt.split('[pre-remove]')[1]?.split('[post-remove]')[0] ?? '';
check(preRemove.includes('main|master|live') && !preRemove.includes('check-remove'), 'protected branch hook remains without remote gate');
check(wt.includes('wt step copy-ignored') && wt.includes('known-repos'), 'setup and registry hooks remain');
check(guide.includes('Native wt checks dirty files') && guide.includes('does not prove remote publication'), 'native removal limits are stated');
check(global.includes('## Background Processes') && global.includes('reap-strays'), 'process resource safeguards remain separate');
check(global.includes('Preserve other workers'), 'other workers remain protected');
console.log(`${count} worktree policy checks passed`);
