#!/usr/bin/env node
// Real resource discovery and registered tool schemas, with private HOME and stores. No model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { rollingSource, disabledNpm, prepareRolling } from './prepare-hermes-rolling.mjs';
import { activateRolling } from './activate-hermes-rolling.mjs';
const repo = path.resolve(import.meta.dirname, '..');
const runtime = path.join(os.homedir(), '.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent');
const pkg = path.join(os.homedir(), '.pi/agent/packages/pi-hermes-memory/0.10.0-evidence-v1');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-rolling-test-')));
const home = path.join(root, 'home'), agent = path.join(home, '.pi/agent');
fs.mkdirSync(agent, { recursive: true });
const installed = path.join(os.homedir(), '.pi/agent/npm/node_modules/pi-hermes-memory');
const original = fs.readFileSync(path.join(installed, 'src/handlers/message-parts.ts'));
let child;
try {
  assert.equal(prepareRolling(path.join(os.homedir(), '.pi/agent')), pkg);
  fs.symlinkSync(path.join(os.homedir(), '.pi/agent/npm'), path.join(agent, 'npm'));
  const central = path.join(root, 'central'), nested = path.join(central, 'repo');
  fs.mkdirSync(path.join(central, '.pi'), { recursive: true }); fs.mkdirSync(nested);
  // Resolve ~ through the process's real home here; this fixture uses exact source paths.
  const localOff = { source: pkg, extensions: [] };
  fs.writeFileSync(path.join(central, '.pi/settings.json'), JSON.stringify({ packages: [disabledNpm, localOff] }));
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ packages: [disabledNpm, pkg], extensions: ['-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search'], enableInstallTelemetry: false }));
  const { DefaultResourceLoader, SettingsManager } = await import(path.join(runtime, 'dist/index.js'));
  const before = { packages: ['npm:pi-hermes-memory', 'npm:unrelated-package'], defaultModel: 'fixture', defaultThinkingLevel: 'high', theme: 'dark' };
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify(before));
  const staleManager = SettingsManager.create(root, agent);
  await activateRolling(agent, runtime);
  staleManager.setTheme('light'); await staleManager.flush();
  const activated = JSON.parse(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8'));
  assert.deepEqual(activated.packages, [disabledNpm, rollingSource, 'npm:unrelated-package']);
  assert.equal(activated.defaultThinkingLevel, 'high'); assert.equal(activated.defaultModel, 'fixture'); assert.equal(activated.theme, 'light');
  await activateRolling(agent, runtime);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8')), activated);
  const fakeCopy = path.join(agent, 'packages/pi-hermes-memory/0.10.0-evidence-v1');
  const sourceFile = path.join(fakeCopy, 'src/handlers/message-parts.ts');
  const sourceBytes = fs.readFileSync(sourceFile); fs.appendFileSync(sourceFile, '\n// drift');
  assert.throws(() => prepareRolling(agent), /drift/); fs.writeFileSync(sourceFile, sourceBytes);
  console.log('PASS locked settings activation, unrelated fields, stale Pi save preservation, idempotence and copied-source drift rejection');
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ packages: [disabledNpm, pkg], extensions: ['-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search'], enableInstallTelemetry: false }));
  const get = async (cwd, trusted) => {
    const manager = SettingsManager.create(cwd, agent, { projectTrusted: trusted });
    const loader = new DefaultResourceLoader({ cwd, agentDir: agent, settingsManager: manager });
    await loader.reload({ resolveProjectTrust: async () => trusted });
    const result = loader.getExtensions(); assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    return result.extensions.filter(e => e.path.includes('pi-hermes-memory'));
  };
  assert.equal((await get(central, true)).length, 0);
  assert.equal((await get(central, false)).length, 1);
  const tools = await get(nested, true); assert.equal(tools.length, 1); assert(tools[0].path.startsWith(pkg));
  console.log('PASS actual Pi 1.5 loader: central trusted off, untrusted on, child on, one local package only');
  const project = JSON.parse(fs.readFileSync(path.join(repo, 'hellofresh/projects/hellofresh/.pi/settings.json'), 'utf8'));
  assert(project.packages.some(p => p.source === rollingSource && p.extensions.length === 0));
  const config = { memoryDir: path.join(root, 'memory'), projectsMemoryDir: path.join(root, 'projects'), reviewEnabled: false, correctionDetection: false, flushOnShutdown: false, flushOnCompact: false, autoConsolidate: false, quickCheckOnOpen: false };
  fs.writeFileSync(path.join(agent, 'hermes-memory-config.json'), JSON.stringify(config));
  // RPC fixture uses private HOME so native module/config paths cannot reach live stores.
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ packages: [{...disabledNpm}, pkg], defaultProvider: 'fixture', defaultModel: 'fixture', compaction: {enabled:false}, enableInstallTelemetry:false }));
  const fixture = path.join(root, 'fixture.ts');
  fs.writeFileSync(fixture, `import fs from 'node:fs';export default function(pi){pi.registerProvider('fixture',{api:'fixture',apiKey:'test',baseUrl:'http://invalid',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:100}],streamSimple(){throw Error('No model call expected')}});pi.registerCommand('rolling-probe',{description:'schemas',handler(_,ctx){const tools=pi.getAllTools().filter(t=>['memory_search','session_search'].includes(t.name));fs.writeFileSync(${JSON.stringify(path.join(root, 'report.json'))},JSON.stringify({tools}));}});}`);
  child = spawn(process.execPath, [path.join(runtime, 'dist/cli.js'), '--offline', '--mode', 'rpc', '--no-session', '--no-skills', '--no-context-files', '--no-mcp', '--no-approve', '-e', fixture], { cwd: root, env: { HOME: home, PATH: process.env.PATH, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let out='', errors=''; child.stdout.on('data',b=>out+=b); child.stderr.on('data',b=>errors+=b);
  const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},20000);
  try {
    child.stdin.write(JSON.stringify({id:'probe',type:'prompt',message:'/rolling-probe'})+'\n');
    const until=Date.now()+15000; while(!fs.existsSync(path.join(root,'report.json'))&&Date.now()<until)await new Promise(r=>setTimeout(r,30));
    assert(fs.existsSync(path.join(root,'report.json')),errors+'\n'+out.slice(-2000));
    const report=JSON.parse(fs.readFileSync(path.join(root,'report.json'),'utf8'));
    assert.equal(report.tools.length,2);assert(report.tools.every(t=>JSON.stringify(t.parameters).includes('scope')));
    child.stdin.end();await once(child,'close');assert.equal(child.exitCode,0,errors);
    console.log('PASS real fresh RPC host loads scoped tools from rolling package, private stores only');
  } finally {clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid,'SIGKILL')}catch{}await once(child,'close');}}
  assert(fs.readFileSync(path.join(installed,'src/handlers/message-parts.ts')).equals(original));
} finally {
  if(child){try{process.kill(-child.pid,'SIGKILL')}catch{}}
  fs.rmSync(root,{recursive:true,force:true});
}
process.exit(0);
