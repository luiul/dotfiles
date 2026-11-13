#!/usr/bin/env node
/** Opt-in real model format samples. No tools, user data, or live settings changes.
 * node scripts/test-close-status-models.mjs --live
 * Models run serially with an explicit token and time budget. Samples are not reliability guarantees.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
assert(process.argv.includes('--live'), 'Pass --live to approve bounded model-format samples');
assert(process.env.AI_MODEL_ROUTER_API_KEY, 'Inherited router authentication is needed');
const root = mkdtempSync(join(tmpdir(), 'close-models-'));
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = join(repo, 'pi/.pi/agent/extensions/close-status.ts');
const pi = join(homedir(), '.pi/agent/bin/pi');
const config = JSON.parse(readFileSync(join(homedir(), '.pi/agent/models.json'), 'utf8'));
const models = ['Kimi K3.1 Pro', 'GPT-6.1 Terra', 'GLM 5.3'];
for (const model of models) assert(config.providers['ai-model-router'].models.some(m => m.id === model), 'Configured model missing: ' + model);
const provider = config.providers['ai-model-router'];
writeFileSync(join(root, 'models.json'), JSON.stringify({ providers: { 'ai-model-router': { ...provider, apiKey: '$AI_MODEL_ROUTER_API_KEY', models: provider.models.filter(m => models.includes(m.id)).map(m => ({ ...m, maxTokens: 2048 })) } } }), { mode: 0o600 });
writeFileSync(join(root, 'settings.json'), JSON.stringify({ packages: [], extensions: [], retry: { enabled: false }, cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false }));
const install = join(homedir(), '.pi/agent/install');
const modules = join(install, 'releases', readFileSync(join(install, 'current-version'), 'utf8').trim(), 'node_modules');
const { createJiti } = await import(pathToFileURL(join(modules, 'jiti/lib/jiti.mjs')).href);
const jiti = createJiti(import.meta.url, { alias: { '@earendil-works/pi-tui': join(modules, '@earendil-works/pi-tui/dist/index.js') } });
const { parseCloseReport, CLOSE_GUIDANCE } = await jiti.import(extension);
const cases = [
  { expected: 'yes', text: 'A requested read-only research report is delivered. No decision, publication, tools, or background work remain.' },
  { expected: 'no', text: 'Implementation is tested. Luis has not reviewed it or approved publication. This session owns unpublished changes.' },
  { expected: 'no', text: 'The approved changes are published to remote main and deployment was verified separately. Required live main checkout sync is the only remaining task and has not been done.' },
  { expected: 'yes', text: 'The published commit is present in the live main checkout. All required deployment checks passed. No other session work or decision remains.' },
  { expected: 'yes', text: 'The approved changes are published. Luis explicitly deferred the live main checkout sync until tomorrow. No other session work or decision remains.' },
  { expected: 'unknown', text: 'The approved changes are published. The live main checkout must contain that commit, but its sync state is unknown and cannot be checked. No other work is pending.' },
  { expected: 'yes', text: 'Luis explicitly requested remote-only publication. The approved changes are published. No other session work or decision remains.' },
  { expected: 'yes', text: 'Luis explicitly deferred unpublished work until tomorrow. The named checkout and transcript are preserved. No processes run and no answer is pending.' },
];
async function run(model, text) {
  const args = ['--mode', 'json', '--print', '--no-session', '--no-extensions', '--no-mcp', '--no-tools', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--provider', 'ai-model-router', '--model', model, '--thinking', 'high', '--append-system-prompt', CLOSE_GUIDANCE, `Respond briefly with the closing report for this hypothetical situation. Do not perform work. Situation: ${text}`];
  const child = spawn(pi, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PI_CODING_AGENT_DIR: root } });
  let out = '', err = '';
  const timeout = setTimeout(() => child.kill('SIGTERM'), 90000);
  const kill = setTimeout(() => child.kill('SIGKILL'), 95000);
  child.stdout.on('data', chunk => { out += chunk; if (out.length > 2000000) child.kill('SIGTERM'); });
  child.stderr.on('data', chunk => { err += chunk; });
  try {
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    assert.equal(code, 0, err.slice(-1000));
    const records = out.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const last = records.filter(r => r.type === 'message_end' && r.message?.role === 'assistant').at(-1)?.message;
    assert(last && last.stopReason === 'stop', 'Missing normally completed assistant response');
    const parsed = parseCloseReport(last.content.filter(p => p.type === 'text').map(p => p.text).join('\n'));
    return { parsed, text: last.content.filter(p => p.type === 'text').map(p => p.text).join('\n'), cacheRead: last.usage?.cacheRead, input: last.usage?.input, output: last.usage?.output, cost: last.usage?.cost?.total };
  } finally { clearTimeout(timeout); clearTimeout(kill); }
}
try {
  let failures = 0;
  for (const model of models) for (const scenario of cases) {
    const result = await run(model, scenario.text);
    console.log(JSON.stringify({ model, expected: scenario.expected, actual: result.parsed?.safe_to_close, cacheRead: result.cacheRead, input: result.input, output: result.output, cost: result.cost }));
    if (result.parsed?.safe_to_close !== scenario.expected) { failures++; console.log(JSON.stringify({ model, invalidReply: result.text })); }
  }
  const total = models.length * cases.length;
  console.log(`${total - failures}/${total} sampled model cases passed. This does not establish general reliability.`);
  if (failures) process.exitCode = 1;
} finally { rmSync(root, { recursive: true, force: true }); }
