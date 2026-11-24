#!/usr/bin/env node
/** Real Pi discovery, private copies/settings/stores, no model or live writes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rollingSource, legacySource, disabledNpm, prepareRolling } from './prepare-hermes-rolling.mjs';
import { activateRolling, resolveManagedRuntime } from './activate-hermes-rolling.mjs';
import { activeHermes } from './test-hermes-fixture.mjs';
const runtime = resolveManagedRuntime();
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-rolling-test-')));
const home = path.join(root, 'home'), agent = path.join(home, '.pi/agent');
fs.mkdirSync(path.join(agent,'packages/pi-hermes-memory'), { recursive: true });
let child;
const alive = pid => { try { process.kill(pid,0); return true; } catch(e) { if(e.code==='ESRCH')return false; throw e; } };
try {
  fs.cpSync(activeHermes,path.join(agent,'packages/pi-hermes-memory/0.10.0-evidence-v1'),{recursive:true});
  const pkg = prepareRolling(agent,undefined,true);
  const central = path.join(root, 'central'), nested = path.join(central, 'repo');
  fs.mkdirSync(path.join(central, '.pi'), { recursive: true }); fs.mkdirSync(nested);
  const off = source => ({source,extensions:[],skills:[],prompts:[],themes:[]});
  const reviewedCentral = JSON.parse(fs.readFileSync(new URL('../hellofresh/projects/hellofresh/.pi/settings.json', import.meta.url), 'utf8'));
  for (const source of [disabledNpm.source, legacySource, rollingSource]) {
    assert(reviewedCentral.packages.some(p => p.source === source && Array.isArray(p.extensions) && p.extensions.length === 0), `Reviewed central intake must exclude ${source}`);
  }
  const centralFile=path.join(central,'.pi/settings.json');
  fs.writeFileSync(centralFile,JSON.stringify({packages:[disabledNpm,off(legacySource),off(rollingSource)]}));
  fs.writeFileSync(path.join(agent,'settings.json'),JSON.stringify({packages:[disabledNpm,legacySource],theme:'dark'}));
  await activateRolling(agent,runtime,true,centralFile);
  // Resource discovery uses an exact private path, not ~ resolved in this test owner.
  fs.writeFileSync(centralFile,JSON.stringify({packages:[disabledNpm,off(pkg)]}));
  const config = { memoryDir:path.join(root,'memory'),projectsMemoryDir:path.join(root,'projects'),reviewEnabled:false,correctionDetection:false,flushOnShutdown:false,flushOnCompact:false,autoConsolidate:false,quickCheckOnOpen:false };
  fs.writeFileSync(path.join(agent,'hermes-memory-config.json'),JSON.stringify(config));
  fs.writeFileSync(path.join(agent,'settings.json'),JSON.stringify({packages:[disabledNpm,pkg],extensions:['-builtin:mcp','-builtin:llama.cpp','-builtin:codemode','-builtin:tool-search'],enableInstallTelemetry:false}));
  const fixture=path.join(root,'fixture.ts'), report=path.join(root,'report.json');
  // Run the loader in a private host. Importing Hermes here in the test owner
  // would use its real HOME for paths.ts despite a private resource-loader agentDir.
  fs.writeFileSync(fixture,`import fs from 'node:fs';import {DefaultResourceLoader,SettingsManager} from '@earendil-works/pi-coding-agent';export default function(pi){pi.registerCommand('rolling-probe',{description:'schemas and discovery',async handler(_,ctx){const get=async(cwd,trusted)=>{const settingsManager=SettingsManager.create(cwd,${JSON.stringify(agent)},{projectTrusted:trusted});const loader=new DefaultResourceLoader({cwd,agentDir:${JSON.stringify(agent)},settingsManager});await loader.reload({resolveProjectTrust:async()=>trusted});const result=loader.getExtensions();if(result.errors.length)throw Error(JSON.stringify(result.errors));return result.extensions.filter(e=>e.path.includes('pi-hermes-memory')).map(e=>e.path)};fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({tools:pi.getAllTools().filter(t=>['memory_search','session_search'].includes(t.name)),trusted:await get(${JSON.stringify(central)},true),untrusted:await get(${JSON.stringify(central)},false),nested:await get(${JSON.stringify(nested)},true)}));}});}`);
  child=spawn(process.execPath,[path.join(runtime,'dist/cli.js'),'--offline','--mode','rpc','--no-session','--no-skills','--no-context-files','--no-mcp','--no-approve','-e',fixture],{cwd:root,env:{HOME:home,PATH:process.env.PATH,PI_CODING_AGENT_DIR:agent,TMPDIR:root,XDG_CACHE_HOME:path.join(root,'cache'),JITI_CACHE_DIR:path.join(root,'jiti'),PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1'},stdio:['pipe','pipe','pipe']});
  let err='',out='';child.stdout.on('data',b=>out=(out+b).slice(-6000));child.stderr.on('data',b=>err=(err+b).slice(-6000));
  const completion=once(child,'close'), timer=setTimeout(()=>child.kill('SIGKILL'),35000);
  try {
    child.stdin.write(JSON.stringify({id:'probe',type:'prompt',message:'/rolling-probe'})+'\n');
    const end=Date.now()+30000;while(!fs.existsSync(report)&&Date.now()<end)await new Promise(r=>setTimeout(r,30));
    assert(fs.existsSync(report),err+'\n'+out);
    const value=JSON.parse(fs.readFileSync(report,'utf8'));
    assert.equal(value.tools.length,2);assert(value.tools.every(t=>JSON.stringify(t.parameters).includes('scope')));
    assert.deepEqual(value.trusted,[]);assert.equal(value.untrusted.length,1);assert.equal(value.nested.length,1);assert(value.nested[0].startsWith(pkg));
    child.stdin.end();const [code]=await completion;assert.equal(code,0,err);assert(!alive(child.pid));
    console.log('PASS Pi '+JSON.parse(fs.readFileSync(path.join(runtime,'package.json'))).version+' fresh RPC scoped tools, trusted central off, untrusted on, child on, one private local package');
  }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await completion;}}
}finally{
  if(child?.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  fs.rmSync(root,{recursive:true,force:true});assert(!fs.existsSync(root));
}
