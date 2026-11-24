#!/usr/bin/env node
/** Rotated offline custom-stack benchmark. Private stores, local responses, no provider traffic. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { RexTestDriver } from './rex-test-driver.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const baseline = resolve(arg('--baseline') || '');
assert(arg('--baseline') && existsSync(join(baseline, 'pi/.pi/agent/extensions/zen.ts')), 'Supply a saved baseline checkout with --baseline');
const repeats = Number(arg('--repeats') || 7);
assert(Number.isInteger(repeats) && repeats >= 7 && repeats <= 15);
const mode = arg('--mode') || 'rpc';
const smoke = process.argv.includes('--smoke');
assert(['rpc', 'tui'].includes(mode));
const version = readFileSync(join(homedir(), '.pi/agent/install/current-version'), 'utf8').trim();
assert.equal(version, '1.6.0', 'Reverify the fixture before testing another Pi release');
const cli = join(homedir(), '.pi/agent/install/releases', version, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const contextMode = join(homedir(), '.pi/agent/npm/node_modules/context-mode');
const root = mkdtempSync(join(tmpdir(), 'pi-setup-bench-'));
const extensions = ['aws-sso-refresh.ts', 'bedrock-openai-reasoning.ts', 'bedrock-region-sync.ts', 'router-image-cap.ts', 'zen.ts', 'session-title.ts', 'status-bar.ts', 'zsh-bang.ts', 'rtk.ts', 'close-status.ts', 'gui-environment.ts', 'scoped-agent-context.ts', 'filechanges.ts', 'code-blocks/index.ts', 'model-guide.ts', 'resource-budget.ts'];
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function dependencyHashes(source) {
  const base = join(source, 'pi/.pi/agent');
  const files = [];
  const visit = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) visit(path); else if (entry.isFile() && /\.(?:ts|js|mjs|json)$/.test(entry.name)) files.push(path); } };
  visit(join(base, 'extensions'));
  visit(join(base, 'patches/context-mode'));
  return Object.fromEntries(files.sort().map(path => [path.slice(base.length + 1), hash(path)]));
}
const dependencyFingerprints = Object.fromEntries(Object.entries({ baseline, candidate: repo }).map(([name, path]) => [name, dependencyHashes(path)]));
const sourceHashes = Object.fromEntries(Object.entries({ baseline, candidate: repo }).map(([variant, path]) => [variant, Object.fromEntries(extensions.map(name => [name, hash(join(path, 'pi/.pi/agent/extensions', name))]))]));
const fixture = join(root, 'fixture.ts');
writeFileSync(fixture, `import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from '@earendil-works/pi-ai';
export default function(pi) {
 const note = (type, data={}) => appendFileSync(process.env.SETUP_BENCH_EVENTS, JSON.stringify({type,...data})+'\\n');
 const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
 pi.on('session_start', (_event,ctx) => note('ready',{commands:pi.getCommands().filter(c=>c.source==='extension').map(c=>c.name).sort(),tools:pi.getAllTools().map(t=>t.name).sort()}));
 pi.on('agent_settled', () => note('settled'));
 pi.registerTool({name:'setup_probe',label:'fixture',description:'offline setup fixture',parameters:{type:'object',properties:{}},async execute(){return {content:[{type:'text',text:'PROBE_OK'}],details:{}};}});
 pi.registerProvider('setup-fixture',{api:'setup-fixture-api',apiKey:'fixture',baseUrl:'http://fixture.invalid',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:128}],streamSimple(model,context){
  note('request',{prompt: digest(getCurrentSystemPrompt(context.messages)),tools:digest(pi.getActiveTools().slice().sort())});
  const last=context.messages.at(-1);const tool=last?.role!=='toolResult';
  const marker='SETUP_FIXTURE_OK_'+context.messages.filter(m=>m.role==='user').length;
  const s=createAssistantMessageEventStream();const content=tool?[{type:'toolCall',id:'probe-'+Date.now(),name:'setup_probe',arguments:{}}]:[{type:'text',text:marker+'\\n\\n'+String.fromCharCode(96).repeat(3)+'typescript\\nconst answer = 42;\\n'+String.fromCharCode(96).repeat(3)}];
  const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content,stopReason:tool?'toolUse':'stop',usage:{input:32,output:8,cacheRead:0,cacheWrite:0,totalTokens:40,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  queueMicrotask(()=>{s.push({type:'start',partial:message});if(tool){s.push({type:'toolcall_start',contentIndex:0,partial:message});s.push({type:'toolcall_end',contentIndex:0,toolCall:content[0],partial:message});}else{s.push({type:'text_start',contentIndex:0,partial:message});s.push({type:'text_delta',contentIndex:0,delta:content[0].text,partial:message});s.push({type:'text_end',contentIndex:0,content:content[0].text,partial:message});}s.push({type:'done',reason:message.stopReason,message});s.end();});return s;
 }});
}`);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const stats = values => { const m = median(values); return { median: m, mad: median(values.map(v => Math.abs(v - m))) }; };
const results = { baseline: [], candidate: [] };
let driver;
const sample = pid => {
  const r = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'time=,rss='], { encoding: 'utf8', timeout: 3000 });
  assert.equal(r.status, 0, r.stderr);
  const [time, rss] = r.stdout.trim().split(/\s+/);
  const parts = time.split(':').map(Number);
  const cpuSeconds = parts.reduce((total, value) => total * 60 + value, 0);
  return { cpuSeconds, rssKiB: Number(rss) };
};
async function trial(variant, round) {
  const home = join(root, variant + '-' + round), agent = join(home, '.pi/agent');
  mkdirSync(join(agent, 'npm/node_modules'), { recursive: true });
  symlinkSync(contextMode, join(agent, 'npm/node_modules/context-mode'));
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [], theme: 'dark', quietStartup: true, outputPad: 0, tuiMode: 'fullscreen', fullscreenCopyOnSelect: false, markdown: { codeBlockIndent: '' }, cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false, defaultProjectTrust: 'never', compaction: { enabled: false }, retry: { enabled: false } }));
  const eventsPath = join(home, 'events.jsonl');
  const cwd = join(root, 'project'); mkdirSync(cwd, { recursive: true });
  const source = variant === 'baseline' ? baseline : repo;
  const args = [process.execPath, cli, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-mcp', '--no-approve', '--provider', 'setup-fixture', '--model', 'fixture', '--thinking', 'off', '--session-dir', join(home, 'sessions'), ...(mode === 'rpc' ? ['--mode', 'rpc'] : []), ...extensions.flatMap(name => ['-e', join(source, 'pi/.pi/agent/extensions', name)]), '-e', fixture];
  const env = { HOME: home, PATH: process.env.PATH, TMPDIR: home, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_PROGRAM_STATUS: '0', PI_IMAGE_PROTOCOL: 'none', PI_TRUE_COLOR: '1', AI_MODEL_ROUTER_API_KEY: 'offline-fixture', SETUP_BENCH_EVENTS: eventsPath };
  let child, host, stderr = '', buffer = '', timer;
  const messages = [];
  const notes = () => existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const wait = async (predicate, label, limit = 15000) => { const end = Date.now() + limit; while (Date.now() < end) { if (predicate()) return; if (child && (child.exitCode !== null || child.signalCode !== null)) throw Error(label + ': host exited ' + stderr.slice(-1000)); await delay(20); } throw Error('Deadline: ' + label + ' ' + stderr.slice(-1000)); };
  const began = performance.now();
  try {
    if (mode === 'tui') host = driver.create({ command: args, cwd, env, columns: 120, rows: 44 });
    else {
      child = spawn(args[0], args.slice(1), { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.on('data', data => { buffer += data; let i; while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) messages.push(JSON.parse(line)); } });
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-10000); });
      timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } }, 30000);
      child.stdin.write(JSON.stringify({ id: 'ready', type: 'get_state' }) + '\n');
    }
    await wait(() => notes().some(e => e.type === 'ready') && (mode === 'tui' ? /Fixture/.test(driver.capture(host)) : messages.some(e => e.id === 'ready')), 'ready and footer');
    const startupMs = performance.now() - began;
    const turns = [];
    for (let i = 0; i < 3; i++) {
      const count = notes().filter(e => e.type === 'settled').length, started = performance.now();
      if (mode === 'tui') { driver.text(host, 'Run the offline fixture.'); driver.key(host, 'enter'); }
      else child.stdin.write(JSON.stringify({ id: 'turn' + i, type: 'prompt', message: 'Run the offline fixture.' }) + '\n');
      await wait(() => notes().filter(e => e.type === 'settled').length > count, 'settled');
      if (mode === 'tui') await wait(() => driver.capture(host).includes(`SETUP_FIXTURE_OK_${i + 1}`), 'current turn final paint');
      turns.push(performance.now() - started);
    }
    const pid = mode === 'tui' ? driver.pid(host) : child.pid;
    const before = sample(pid); await delay(2000); const after = sample(pid);
    const records = notes();
    assert.equal(records.filter(e => e.type === 'request').length, 6, 'Each turn must use the same tool and follow-up');
    assert(!messages.some(e => e.type === 'extension_error'), JSON.stringify(messages.filter(e => e.type === 'extension_error')));
    if (mode === 'rpc') assert.equal(messages.filter(e => e.type === 'message_end' && e.message?.role === 'assistant' && e.message.stopReason === 'stop').length, 3);
    const viewport = mode === 'tui' ? driver.capture(host, { history: true }) : '';
    assert(!/Extension error|Failed to load extension/.test(viewport + stderr));
    if (mode === 'tui') { assert(viewport.includes('PROBE_OK') || viewport.includes('setup_probe')); if (variant === 'candidate') assert(viewport.includes('╭─ typescript'), 'Restored frames missing'); }
    results[variant].push({ round, markers: ['SETUP_FIXTURE_OK_1', 'SETUP_FIXTURE_OK_2', 'SETUP_FIXTURE_OK_3'], startupMs, turnMs: turns, idleCpuSeconds: after.cpuSeconds - before.cpuSeconds, rssKiB: after.rssKiB, declarations: records.find(e => e.type === 'ready'), requests: records.filter(e => e.type === 'request') });
  } finally {
    if (timer) clearTimeout(timer);
    if (host) { driver.key(host, 'ctrl+d'); await wait(() => driver.method(host, 'process').last_exit?.exit_code !== undefined, 'clean TUI exit', 8000); assert.equal(driver.method(host, 'process').last_exit.exit_code, 0); driver.close(host); }
    if (child) {
      child.stdin.end();
      const stop = Date.now() + 7000; while (child.exitCode === null && child.signalCode === null && Date.now() < stop) await delay(25);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); const end = Date.now() + 1000; while (child.exitCode === null && child.signalCode === null && Date.now() < end) await delay(25); }
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); throw Error('Host needed forced cleanup'); }
      assert.equal(child.exitCode, 0, stderr);
    }
  }
}
try {
  if (mode === 'tui') driver = await RexTestDriver.start({ deadlineMs: 12 * 60000 });
  for (let round = 0; round <= (smoke ? 0 : repeats); round++) for (const variant of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) await trial(variant, round);
  const summary = {};
  for (const variant of ['baseline', 'candidate']) {
    const rows = smoke ? results[variant] : results[variant].slice(1);
    summary[variant] = { startupMs: stats(rows.map(r => r.startupMs)), turnMs: stats(rows.flatMap(r => r.turnMs)), rssKiB: stats(rows.map(r => r.rssKiB)), idleCpuSeconds: rows.map(r => r.idleCpuSeconds) };
    for (const row of rows) { assert.deepEqual(row.declarations, results.baseline[0].declarations, 'Commands/tools changed'); assert.deepEqual(row.requests, results.baseline[0].requests, 'Prompt/tool declarations changed'); }
  }
  for (const [variant, source] of Object.entries({ baseline, candidate: repo })) {
    for (const name of extensions) assert.equal(hash(join(source, 'pi/.pi/agent/extensions', name)), sourceHashes[variant][name], 'Source changed during benchmark');
    assert.deepEqual(dependencyHashes(source), dependencyFingerprints[variant], 'Extension module or data changed during benchmark');
  }
  const report = { pi: version, node: process.version, mode, backend: mode === 'tui' ? 'private Rex 120x44' : 'RPC subprocess', sourceHashes, dependencyFingerprints, repeats: smoke ? 1 : repeats, smokeOnly: smoke, warmupPairs: smoke ? 0 : 1, idleIntervalSeconds: 2, cpuResolutionSeconds: 0.01, summary, pairedStartupDeltaMs: results.baseline.slice(1).map((row, i) => results.candidate[i + 1].startupMs - row.startupMs), promptAndToolParity: true, results, limits: 'Custom stack only, installed third-party packages and background memory review excluded. No provider latency, billing, caching or model quality claim. ps RSS is process residency, not unique physical memory.' };
  if (arg('--output')) writeFileSync(resolve(arg('--output')), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, results: undefined, sourceHashes: undefined, dependencyFingerprints: undefined }, null, 2));
} finally { if (driver) { const stopped = await driver.stop(); assert(stopped.clean && !existsSync(driver.root), 'Private Rex cleanup incomplete'); } rmSync(root, { recursive: true, force: true }); }
