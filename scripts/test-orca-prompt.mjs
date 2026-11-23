#!/usr/bin/env node
/** Test the Markdown command with the installed Pi loader, not a copied parser. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const install = join(homedir(), '.pi/agent/install');
const release = readFileSync(join(install, 'current-version'), 'utf8').trim();
const core = join(install, 'releases', release, 'node_modules/@earendil-works/pi-coding-agent/dist/core');
const { loadPromptTemplates, expandPromptTemplate } = await import(pathToFileURL(join(core, 'prompt-templates.js')));
const path = join(repo, 'pi/.pi/agent/prompts/orca.md');
const result = loadPromptTemplates({ cwd: repo, agentDir: join(repo, 'pi/.pi/agent'), promptPaths: [], includeDefaults: true });
assert.deepEqual(result.diagnostics, []);
const matches = result.templates.filter(t => t.name === 'orca');
assert.equal(matches.length, 1, 'Exactly one /orca prompt must load');
const prompt = matches[0];
assert.equal(prompt.filePath, path);
assert.equal(prompt.argumentHint, '<task, context, or ticket URL>');
assert.match(prompt.description, /Coordinate a task through Orca workers/);
assert(result.templates.some(t => t.name === 'proofread'));
assert(result.templates.some(t => t.name === 'scratch'));
console.log(`PASS Pi ${release}: /orca loads beside /proofread and /scratch`);

function request(text) {
  const expanded = expandPromptTemplate(text, result.templates);
  return { expanded, input: expanded.split('## Request\n\n')[1]?.split('\n\nIf the request is empty')[0] };
}
for (const text of [
  'Discover ownership of these DAGs',
  'Plan only: do not edit files',
  'Implement the approved scope in https://hellofresh.atlassian.net/browse/GLOA-123',
  'Review the full diff and failure paths',
  'Research official options without sending private evidence to public search',
  'Design retry behavior; preserve the contract; no edits',
  'Verify the requirements with local checks, not production reruns',
  'Audit credential handling without installation',
  'Benchmark the same bounded workload before and after',
  'Refactor approved files without changing public behavior',
  'Plan a schema migration, then wait',
  'Document the approved behavior in the README',
  'Summarize findings and hand off; do not start workers',
  'Continue the recorded Run after verifying coordinator ownership',
  'Troubleshoot USER_ACCESS_DISABLED; no code fix may be needed',
  'Inspect $(touch /tmp/not-executed) and $ARGUMENTS literally',
  "Explain why the job doesn't run",
]) {
  assert.equal(request('/orca ' + text).input, text);
}
const multiline = 'First alert\n[FIRING:1] recipe-index\n  Cluster: dwh-k8s.hellofresh.io';
assert.equal(request('/orca "' + multiline + '"').input, multiline, 'Quoted layout must survive');
assert.equal(request('/orca First alert\nSecond alert').input, 'First alert Second alert', 'Pi joins unquoted arguments');
assert.equal(request('/orca').input, '');
assert.match(request('/orca').expanded, /If the request is empty, ask what task I want done\. Do not create a Run or launch workers yet/);
assert.equal(expandPromptTemplate('/orca-other task', result.templates), '/orca-other task');
assert.equal(expandPromptTemplate('ordinary task', result.templates), 'ordinary task');
console.log('PASS core and specialized requests, recovery, empty and literal input expansion');
console.log('PASS quoted multiline preservation and documented unquoted whitespace normalization');

// These checks guard the reviewed instruction contract, not model compliance.
const contracts = [
  ['current coordinator', 'Use this Pi session as the coordinator', 'Do not start another coordinator'],
  ['Orca delegation', 'not Pi subagents', 'version-matched guides', 'report the concrete blocker'],
  ['mode boundaries', 'Discovery stays read-only', 'Planning returns a plan, not edits', 'No code change can be the correct result'],
  ['bounded workers', 'at most two concurrent', 'self-contained brief', 'Do not split simultaneous alerts by alert count alone'],
  ['worktree ownership', 'separate wt-managed checkouts', 'Finish and verify setup before dispatching', 'Never use native Orca worktree creation or deletion'],
  ['wake and recovery', 'end your turn and let Orca wake you', 'Do not poll, sleep, run watch loops', 'Do not blindly relaunch'],
  ['waiting report', 'Ending your turn is not finishing the workflow', 'Waiting for <count> worker(s)', 'safe_to_close: no', 'Do not offer optional next actions while workers are pending'],
  ['recovery anchor', 'Coordination: run <id>; task <id>; dispatch <id>; workspace <path>', 'Never invent missing IDs', 'Recover ownership before coordinating', 'Do not consume another coordinator'],
  ['completion blockers', 'A worker task finishing is not the requested outcome finishing', 'unanswered questions or escalations', 'pending coordinator review', 'unknown dispatch outcomes', 'an explicit handoff'],
  ['native status limit', 'This prompt controls your reports, not the sidebar', 'Do not keep the coordinator artificially busy'],
  ['human decisions', 'only after my explicit answer', 'Leave implementation changes unstaged for review'],
  ['central intake', 'exactly `~/projects/hellofresh`', 'Hermes memory tools absent', 'Blackhole memory workers disabled', 'create through Harvest', 'Do not use native Orca Jira writes'],
  ['intake blocker', 'give me the exact manual intake handoff', 'pause the ticket-dependent work', 'separate fixing session'],
  ['verification and closure', 'inspect the full diff yourself', 'Do not call an unrun check passed', 'Account for every worker', 'preserve uncertain resources'],
];
for (const [name, ...phrases] of contracts) {
  for (const phrase of phrases) assert(prompt.content.toLowerCase().includes(phrase.toLowerCase()), `${name}: missing ${phrase}`);
  console.log('PASS instruction contract: ' + name);
}
assert.equal((prompt.content.match(/\$ARGUMENTS/g) ?? []).length, 1);
assert(!/\u2014|[ \t]-[ \t]/.test(prompt.content), 'No dash punctuation in prose');
const docs = readFileSync(join(repo, 'orca/README.md'), 'utf8');
assert.match(docs, /instructions|guides the agent/);
assert.match(docs, /does not enforce a permission or security boundary/);
assert.match(docs, /not model compliance/);
for (const [i, name] of ['Discover', 'Research', 'Diagnose', 'Design', 'Plan', 'Implement', 'Review', 'Verify', 'Explain'].entries()) {
  assert(docs.includes(`| ${i + 1} | **${name}**`), `Missing numbered core request ${name}`);
}
for (const name of ['Audit', 'Benchmark', 'Refactor', 'Migrate', 'Document', 'Summarize', 'Hand off']) {
  assert(docs.includes(`| **${name}**`), `Missing focused request ${name}`);
}
assert.match(docs, /not parser modes, flags, native Orca commands, or permission levels/);
assert.match(docs, /The prompt cannot change that badge/);
assert.match(docs, /no action picker or special `help` parser/);
assert.match(docs, /wake.?up and recovery fixture is separate, opt-in/);
console.log('PASS numbered specialized-request reference, interface disclaimers and native status limits');
console.log('ALL PASS: prompt discovery, expansion, instruction contracts and documented verification limits');
