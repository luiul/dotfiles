#!/usr/bin/env node
// Real Pi and private Rex fixtures. No vendor calls or live settings writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { RexTestDriver } from './rex-test-driver.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = join(repo, 'pi/.pi/agent/extensions/model-guide.ts');
const footer = join(repo, 'pi/.pi/agent/extensions/status-bar.ts');
const install = join(homedir(), '.pi/agent/install');
const release = fs.readFileSync(join(install, 'current-version'), 'utf8').trim();
const cli = join(install, 'releases', release, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const root = fs.mkdtempSync(join(tmpdir(), 'model-guide-live-'));
const home = join(root, 'home'), agent = join(home, '.pi/agent');
fs.mkdirSync(agent, { recursive: true });
const settings = JSON.parse(fs.readFileSync(join(repo, 'pi/.pi/agent/settings.json')));
const catalog = JSON.parse(fs.readFileSync(join(repo, 'pi/.pi/agent/models.json')));
const scope = settings.enabledModels;
const all = scope.map(key => {
  const slash = key.indexOf('/'), provider = key.slice(0, slash), id = key.slice(slash + 1);
  const model = catalog.providers[provider].models?.find(m => m.id === id) ?? {
    id, name: catalog.providers[provider].modelOverrides[id].name, reasoning: true, input: ['text', 'image'],
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 1024,
  };
  return { ...model, provider };
});
const evidence = join(repo, 'pi/.pi/agent/model-guide.json');
const fixture = join(root, 'fixture.ts');
fs.writeFileSync(fixture, `import {appendFileSync} from 'node:fs';
import {createAssistantMessageEventStream,getCurrentSystemPrompt} from '@earendil-works/pi-ai';
export default function(pi){
 const note=(type,data={})=>appendFileSync(process.env.GUIDE_LOG,JSON.stringify({type,...data})+'\\n');
 const models=${JSON.stringify(all)};
 for(const provider of [...new Set(models.map(m=>m.provider))])pi.registerProvider(provider,{
  api:'guide-fixture',baseUrl:'http://never.invalid',apiKey:'fixture',models:[...models.filter(m=>m.provider===provider),...(provider==='ai-model-router'?[{...models[0],id:'Outside',name:'Outside',reasoning:false}]:[])],
  streamSimple(model,context,options){const s=createAssistantMessageEventStream();queueMicrotask(async()=>{
   note('provider',{provider:model.provider,model:model.id,prompt:getCurrentSystemPrompt(context.messages),tools:context.tools});
   const m={role:'assistant',provider:model.provider,model:model.id,api:model.api,timestamp:Date.now(),content:[{type:'text',text:'GUIDE_DONE'}],stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
   s.push({type:'done',reason:'stop',message:m});s.end();});return s;}
 });
 pi.on('session_start',(_e,ctx)=>note('ready',{model:ctx.model?.id,scope:ctx.scopedModels.map(x=>x.model.provider+'/'+x.model.id),effort:pi.getThinkingLevel()}));
 pi.on('session_shutdown',()=>note('shutdown'));
 pi.registerCommand('fixture-probe',{handler:(_a,ctx)=>ctx.ui.notify('FIXTURE_READY','info')});
 pi.registerCommand('fixture-state',{handler:(_a,ctx)=>{note('state',{model:ctx.model.id,effort:pi.getThinkingLevel()});ctx.ui.notify('STATE_RECORDED','info')}});
}`);
fs.writeFileSync(join(agent, 'settings.json'), JSON.stringify({
  enabledModels: scope, modelThinkingLevels: settings.modelThinkingLevels, defaultProvider: 'ai-model-router', defaultModel: 'GPT-6.1 Terra',
  quietStartup: true, theme: 'dark', cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false },
}));
const env = { HOME: home, PATH: process.env.PATH, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_TELEMETRY: '0', LANG: 'en_US.UTF-8' };
const common = [cli, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-mcp', '--no-tools', '--no-session', '-e', fixture];
const parse = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  do { const value = fn(); if (value) return value; await delay(80); } while (Date.now() < end);
  throw Error('Timed out waiting for fixture');
}
function json(on, n) {
  const log = join(root, `json-${n}-${on}.jsonl`);
  const start = performance.now();
  const r = spawnSync(process.execPath, [...common, ...(on ? ['-e', extension] : []), '--mode', 'json', '-p', 'Say ready'],
    { cwd: root, env: { ...env, GUIDE_LOG: log }, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr || r.error?.message || `signal ${r.signal}`); assert(!/Failed to load|Extension error/.test(r.stderr ?? ''));
  const notes = parse(log), provider = notes.find(e => e.type === 'provider'); assert(provider);
  return { ms: performance.now() - start, provider };
}
const timings = { baseline: [], guide: [] };
let driver, success = false;
try {
  for (let i = 0; i < 7; i++) {
    const first = json(i % 2 === 0, `${i}-a`), second = json(i % 2 !== 0, `${i}-b`);
    assert.equal(first.provider.prompt, second.provider.prompt, 'Added system prompt content');
    assert.deepEqual(first.provider.tools, second.provider.tools, 'Added tools');
    for (const [on, r] of [[i % 2 === 0, first], [i % 2 !== 0, second]]) timings[on ? 'guide' : 'baseline'].push(r.ms);
  }
  console.log('PASS seven rotated baseline/guide process runs, identical provider prompts and tool sets');
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const mad = values => median(values.map(value => Math.abs(value - median(values))));
  console.log('Fixture process elapsed ms (includes one local completion and shutdown):', JSON.stringify({
    baseline: { median: median(timings.baseline), mad: mad(timings.baseline) },
    guide: { median: median(timings.guide), mad: mad(timings.guide) }, samples: timings }));

  driver = await RexTestDriver.start({ deadlineMs: 240000 });
  const processStats = pid => {
    const [time, rss] = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'time=', '-o', 'rss='], { encoding: 'utf8', timeout: 2000 }).stdout.trim().split(/\s+/);
    const parts = time.split(':').map(Number);
    return { cpuSeconds: parts.reduce((sum, n) => sum * 60 + n, 0), rssKiB: Number(rss) };
  };
  const idleSamples = [];
  for (const on of [false, true]) {
    const idleLog = join(root, `idle-${on}.jsonl`);
    const idle = driver.create({ command: [process.execPath, ...common, ...(on ? ['-e', extension] : [])], cwd: root,
      env: { ...env, GUIDE_LOG: idleLog }, columns: 120, rows: 40 });
    await wait(() => parse(idleLog).some(e => e.type === 'ready'));
    await delay(800);
    const before = processStats(driver.pid(idle));
    await delay(4000);
    const after = processStats(driver.pid(idle));
    idleSamples.push({ guide: on, cpuSeconds4s: +(after.cpuSeconds - before.cpuSeconds).toFixed(3), rssKiB: after.rssKiB });
    assert(!parse(idleLog).some(e => e.type === 'provider'));
    driver.key(idle, 'ctrl+d'); await wait(() => parse(idleLog).some(e => e.type === 'shutdown'));
  }
  console.log('Idle Pi process samples (ps resolution 0.01s):', JSON.stringify(idleSamples));
  const log = join(root, 'tui.jsonl');
  const host = driver.create({ command: [process.execPath, ...common, '-e', extension, '-e', footer], cwd: root,
    env: { ...env, GUIDE_LOG: log }, columns: 120, rows: 40 });
  await wait(() => parse(log).some(e => e.type === 'ready'));
  await delay(400);
  const send = async text => { driver.text(host, text); await delay(80); driver.key(host, 'escape'); driver.key(host, 'enter'); };
  const capture = () => driver.capture(host);
  const pageUntil = async (target, text) => {
    for (let i = 0; i < 40; i++) {
      if (driver.capture(target).includes(text)) return;
      driver.key(target, 'pageDown'); await delay(100);
    }
    throw Error(`Missing paged text: ${text}`);
  };
  await send('/fixture-probe'); await wait(() => capture().includes('FIXTURE_READY'));
  await send('/model-guide');
  const start = performance.now(); await wait(() => capture().includes('Compare two scoped models'));
  console.log('Guide open to captured frame ms:', +(performance.now() - start).toFixed(2));
  driver.key(host, 'escape'); await delay(100);
  const openSamples = [];
  for (let i = 0; i < 7; i++) {
    const at = performance.now(); await send('/model-guide'); await wait(() => capture().includes('Compare two scoped models'));
    openSamples.push(performance.now() - at);
    driver.key(host, 'escape'); await delay(100);
  }
  await send('/model-guide'); await wait(() => capture().includes('Compare two scoped models'));
  console.log('Guide command to captured frame ms (includes input/capture):', JSON.stringify({
    warmMedian: median(openSamples), samples: openSamples }));
  let screen = capture(); assert(screen.includes('Kimi K3.1 Pro')); assert(screen.includes('42 @ high'));
  assert(screen.includes('Unknown at high'));
  assert(!parse(log).some(e => e.type === 'provider'), 'Guide caused provider request');
  driver.key(host, 'right'); driver.key(host, 'down');
  await wait(() => capture().includes('GPT-6.1 Sol'));
  assert(capture().includes('GPT-6.1 Terra')); assert(!capture().includes('Kimi K3.1 Pro'));
  driver.key(host, 'left'); driver.key(host, 'down');
  await wait(() => capture().includes('Kimi K3.1 Pro'));
  assert(capture().includes('GPT-6.1 Sol'));
  driver.key(host, 'right'); driver.text(host, '/'); driver.text(host, 'budget'); await delay(150); driver.key(host, 'enter');
  await wait(() => capture().includes('GLM 5.3'));
  assert(capture().includes('Kimi K3.1 Pro')); assert(!capture().includes('GPT-6.1 Sol'));
  await pageUntil(host, 'Grove spend/pass');
  assert(capture().includes('$0.06405') && capture().includes('$0.04981'));
  driver.text(host, 'd'); await wait(() => capture().includes('Technical evidence'));
  await pageUntil(host, 'Score source');
  driver.text(host, 'd');
  driver.resize(host, 40, 24); await wait(() => capture().includes('Comparison'));
  const narrow = capture(); assert(narrow.includes('Kimi')); assert(narrow.includes('GLM'));
  driver.key(host, 'pageDown'); await delay(150);
  assert(!/Comparison 1\//.test(capture()));
  driver.resize(host, 12, 16); await wait(() => capture().includes('Model guide'));
  driver.resize(host, 120, 40); await wait(() => capture().includes('Kimi K3.1 Pro'));
  driver.key(host, 'escape'); await send('/fixture-state'); await wait(() => parse(log).some(e => e.type === 'state'));
  assert.deepEqual(parse(log).find(e => e.type === 'state'), { type: 'state', model: 'GPT-6.1 Terra', effort: 'high' });
  driver.resize(host, 120, 40);
  await send('/model'); await wait(() => capture().includes('Kimi K3.1 Pro'));
  assert(capture().includes('Scope:')); driver.key(host, 'tab'); await wait(() => capture().includes('Outside'));
  driver.key(host, 'tab'); await delay(150); assert(!capture().includes('Outside')); driver.key(host, 'escape');
  // Native selection must retain Kimi's configured effort and compact footer identity.
  await send('/model ai-model-router/Kimi K3.1 Pro'); await wait(() => capture().includes('Kimi K3.1 Pro'));
  if (capture().includes('Scope:') || capture().includes('Model Name:')) { driver.key(host, 'enter'); await delay(300); }
  await send('/fixture-state'); await wait(() => parse(log).filter(e => e.type === 'state').length === 2).catch(error => { console.error(capture()); throw error; });
  assert.equal(parse(log).filter(e => e.type === 'state')[1].model, 'Kimi K3.1 Pro');
  assert.equal(parse(log).filter(e => e.type === 'state')[1].effort, 'high');
  screen = capture(); assert(screen.includes('Kimi K3.1 Pro')); assert(!screen.includes('Code | Hard coding'));
  await send('/model-guide'); await wait(() => capture().includes('Compare two scoped models')); driver.key(host, 'enter');
  assert(!parse(log).some(e => e.type === 'provider'));
  driver.key(host, 'ctrl+d'); await wait(() => parse(log).some(e => e.type === 'shutdown'));
  const processResult = await wait(() => {
    const state = driver.method(host, 'process');
    return state.last_exit ? state.last_exit : undefined;
  }, 3000);
  assert.equal(processResult.exit_code, 0);
  console.log('PASS real Pi pair matrix, independent columns, search, narrow resize, metric paging, cancel, native scope toggle, Kimi effort and footer identity');

  const lightLog = join(root, 'light.jsonl');
  const light = driver.create({ command: [process.execPath, ...common, '-e', extension, '--use-theme', 'light', '--models', 'ai-model-router/GPT-6.1 Sol:high'],
    cwd: root, env: { ...env, GUIDE_LOG: lightLog }, columns: 80, rows: 30 });
  await wait(() => parse(lightLog).some(e => e.type === 'ready')); await delay(300);
  driver.text(light, '/model-guide'); driver.key(light, 'enter');
  await wait(() => driver.capture(light).includes('Unknown at high'));
  assert(!driver.capture(light).includes('Kimi K3.1 Pro'));
  driver.text(light, 'd'); await wait(() => driver.capture(light).includes('scope pattern'));
  driver.key(light, 'escape'); driver.key(light, 'ctrl+d');
  await wait(() => parse(lightLog).some(e => e.type === 'shutdown'));
  console.log('PASS real light theme, CLI single-model scope and inline effort override');

  const project = join(root, 'project'); fs.mkdirSync(join(project, '.pi'), { recursive: true });
  fs.writeFileSync(join(project, '.pi/settings.json'), JSON.stringify({ enabledModels: ['ai-model-router/GPT-6 Luna'],
    defaultProvider: 'ai-model-router', defaultModel: 'GPT-6 Luna', modelThinkingLevels: { 'ai-model-router/GPT-6 Luna': 'medium' } }));
  const projectLog = join(root, 'project.jsonl');
  const projectHost = driver.create({ command: [process.execPath, ...common, '-e', extension, '--approve'], cwd: project,
    env: { ...env, GUIDE_LOG: projectLog }, columns: 100, rows: 40 });
  await wait(() => parse(projectLog).some(e => e.type === 'ready')); await delay(300);
  driver.text(projectHost, '/model-guide'); driver.key(projectHost, 'enter');
  await wait(() => driver.capture(projectHost).includes('Unknown at medium'));
  assert(!driver.capture(projectHost).includes('Kimi K3.1 Pro'));
  assert(driver.capture(projectHost).includes('10 @ low'));
  await pageUntil(projectHost, 'Not tested at medium');
  driver.key(projectHost, 'escape'); driver.key(projectHost, 'ctrl+d');
  await wait(() => parse(projectLog).some(e => e.type === 'shutdown'));
  console.log('PASS real project scope and project thinking-pin override');
  success = true;
} catch (error) {
  console.error('TEST FAILURE:', error);
  throw error;
} finally {
  if (driver) await driver.stop();
  if (success) fs.rmSync(root, { recursive: true, force: true });
  else console.error('Fixture retained:', root);
}
