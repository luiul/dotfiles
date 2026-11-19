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
console.log('PASS discovery, planning, implementation, review, incident, empty and literal input expansion');
console.log('PASS quoted multiline preservation and documented unquoted whitespace normalization');

// These checks guard the reviewed instruction contract, not model compliance.
const contracts = [
  ['current coordinator', 'Use this Pi session as the coordinator', 'Do not start another coordinator'],
  ['Orca delegation', 'not Pi subagents', 'version-matched guides', 'report the concrete blocker'],
  ['mode boundaries', 'Discovery stays read-only', 'Planning returns a plan, not edits', 'No code change can be the correct result'],
  ['bounded workers', 'at most two concurrent', 'self-contained brief', 'Do not split simultaneous alerts by alert count alone'],
  ['worktree ownership', 'separate wt-managed checkouts', 'Finish and verify setup before dispatching', 'Never use native Orca worktree creation or deletion'],
  ['wake and recovery', 'end your turn and let Orca wake you', 'Do not poll, sleep, run watch loops', 'Do not blindly relaunch'],
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
console.log('ALL PASS: prompt discovery, expansion, instruction contracts and documented verification limits');
