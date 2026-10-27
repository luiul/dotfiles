#!/usr/bin/env node
/** Isolated native Pi checks. Run: node scripts/test-scoped-agent-context-live.mjs */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const candidate = join(repo, 'pi/.pi/agent/extensions/scoped-agent-context.ts');
export const installed = realpathSync(process.env.SCOPED_TEST_PI_PACKAGE ?? join(homedir(), '.pi/agent/install/current/node_modules/@earendil-works/pi-coding-agent'));
export const cli = join(installed, 'dist/cli.js');
export const sdk = () => import(pathToFileURL(join(installed, 'dist/index.js')).href);
export function put(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
export function run(file, args, env, cwd) {
  try { return execFileSync(file, args, { env, cwd, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { throw new Error(`${file} ${args.join(' ')}: ${error.stderr ?? error.message}`); }
}
export function makeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scoped-context-'))), home = join(root, 'home');
  const config = join(root, 'wt.toml');
  const env = { HOME: home, PATH: process.env.PATH, LANG: 'en_US.UTF-8', WORKTRUNK_AGENT: '1',
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    PI_CODING_AGENT_DIR: join(home, '.pi/agent'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
  const owner = join(home, 'worktrees/owner'), branch = join(owner, 'shared-branch');
  put(config, `worktree-path = ${JSON.stringify(join(branch, '{{ repo }}'))}\n`);
  const git = (cwd, ...args) => run('git', ['-C', cwd, ...args], env);
  const wt = (cwd, ...args) => run('wt', ['--config', config, '-C', cwd, ...args], env);
  const instructions = (dir, mark, name = 'AGENTS.md') => put(join(dir, name), `${mark}\n`);
  instructions(root, 'SC_ROOT'); instructions(home, 'SC_HOME'); instructions(join(home, 'projects'), 'SC_PROJECTS');
  instructions(join(home, 'projects/personal'), 'SC_PERSONAL'); instructions(join(home, 'projects/personal/domain'), 'SC_DOMAIN', 'CLAUDE.md');
  instructions(join(home, 'projects/hellofresh'), 'SC_HF'); instructions(join(home, 'projects/hellofresh/platform'), 'SC_PLATFORM');
  instructions(env.PI_CODING_AGENT_DIR, 'SC_GLOBAL'); instructions(join(home, 'worktrees'), 'SC_WORKTREES'); instructions(branch, 'SC_BRANCH');
  const repos = [];
  function checkout(primary, mark) {
    mkdirSync(primary, { recursive: true }); run('git', ['init', '-b', 'main', primary], env);
    instructions(primary, mark);
    instructions(join(primary, 'nested'), `${mark}_NESTED`, 'CLAUDE.md');
    instructions(join(primary, 'nested/deep'), `${mark}_SHADOWED`);
    instructions(join(primary, 'nested/deep'), `${mark}_OVERRIDE`, 'AGENTS.override.md');
    git(primary, 'add', '.'); git(primary, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
    const entry = { primary, linked: join(branch, primary.split('/').at(-1)), mark };
    repos.push(entry);
    // All configuration, hooks and paths are private. No user's registry or guard runs.
    wt(primary, 'switch', '--create', 'shared-branch', '--base', 'main', '--no-cd', '--no-hooks', '--yes', '--format', 'json');
    assert(existsSync(join(entry.linked, '.git')), `Worktrunk created ${entry.linked}`); return entry;
  }
  let p, hf, other;
  try {
    p = checkout(join(home, 'projects/personal/domain/tool'), 'SC_REPO_P');
    hf = checkout(join(home, 'projects/hellofresh/platform/warehouse'), 'SC_REPO_HF');
    other = checkout(join(home, 'projects/personal/other-tool'), 'SC_REPO_Q');
    symlinkSync(join(home, 'projects/hellofresh/AGENTS.md'), join(owner, 'AGENTS.md'));
  } catch (error) { cleanup(); throw error; }
  function cleanup() {
    for (const r of repos.reverse()) {
      if (existsSync(r.linked)) {
        assert.equal(git(r.linked, 'status', '--porcelain'), '', `Fixture must be clean before removal: ${r.linked}`);
        wt(r.primary, 'remove', 'shared-branch', '--foreground', '--no-hooks', '--yes', '--format', 'json');
        assert(!existsSync(r.linked)); assert(!git(r.primary, 'worktree', 'list', '--porcelain').includes(r.linked));
      }
    }
    rmSync(root, { recursive: true, force: true }); assert(!existsSync(root));
  }
  return { root, home, owner, branch, env, p, hf, other, git, wt, instructions, cleanup };
}

const fixtureSource = `import { appendFileSync } from 'node:fs';
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from '@earendil-works/pi-ai';
export default function(pi) {
  const note = (type, data = {}) => appendFileSync(process.env.SC_LOG, JSON.stringify({type,...data})+'\\n');
  // First probe captures untouched native discovery, before the candidate handler.
  pi.on('before_agent_start', (event) => note('incoming',{files:event.systemPromptOptions.contextFiles}));
  pi.on('session_start', (_event,ctx) => note('ready',{session:ctx.sessionManager.getSessionFile(),pid:process.pid}));
  pi.on('session_shutdown', () => note('shutdown'));
  pi.registerProvider('sc-fixture', {
    api:'sc-fixture-stream',baseUrl:'http://local.invalid',apiKey:'local-fixture',
    models:[{id:'fixture',name:'Scoped Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:256}],
    streamSimple(model,context,options) {
      const stream=createAssistantMessageEventStream();
      queueMicrotask(async()=>{
        const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:[],stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
        try {
          const prompt=getCurrentSystemPrompt(context.messages);
          const systems=context.messages.filter(m=>m.role==='system');
          const payload={messages:context.messages};
          await options?.onPayload?.(payload,model);
          note('provider',{prompt,promptBytes:Buffer.byteLength(prompt),transcriptBytes:Buffer.byteLength(JSON.stringify(context.messages)),systems});
          await options?.onResponse?.({status:200,headers:new Headers()},model);
          const emit=async(e)=>{await options?.onProviderStreamEvent?.(e,model);stream.push(e);};
          await emit({type:'start',partial:message});
          message.content=[{type:'text',text:'SC_DONE'}];
          await emit({type:'text_start',contentIndex:0,partial:message});
          await emit({type:'text_delta',contentIndex:0,delta:'SC_DONE',partial:message});
          await emit({type:'text_end',contentIndex:0,content:'SC_DONE',partial:message});
          await emit({type:'done',reason:'stop',message});stream.end();
        } catch(error) {message.stopReason='error';message.errorMessage=String(error);note('fixture-error',{error:String(error)});stream.push({type:'error',reason:'error',error:message});stream.end();}
      });return stream;
    }
  });
}`;
function records(path) { return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s)) : []; }
function occurrences(text, marker) { return text.split(marker).length - 1; }
function ordered(text, markers) {
  let index = -1;
  for (const marker of markers) { const at = text.indexOf(marker); assert(at > index, `Missing or out of order ${marker}`); index = at; }
}

async function main() {
  const f = makeFixture(), original = readFileSync(candidate, 'utf8'), checks = [], children = new Set();
  const node = process.env.SCOPED_TEST_NODE ?? 'node';
  const fixture = join(f.root, 'provider.ts'); put(fixture, fixtureSource);
  put(join(f.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({quietStartup:true,compaction:{enabled:false},retry:{enabled:false}}));
  let seq = 0;
  const check = (name, fn) => { fn(); checks.push(name); console.log(`PASS ${name}`); };
  const args = (candidateOn, extra = []) => [cli, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-mcp', '--no-themes', '--no-tools', '--no-approve', '--provider', 'sc-fixture', '--model', 'fixture', '--thinking', 'off', '--session-dir', join(f.root, 'sessions'), '-e', fixture, ...(candidateOn ? ['-e', candidate] : []), ...extra];
  function json(cwd, candidateOn, extra = [], env = {}, promptArgs = ['SC_FIRST']) {
    const log = join(f.root, `json-${++seq}.jsonl`);
    const result = spawnSync(node, args(candidateOn, ['--mode', 'json', ...extra, ...promptArgs]), { cwd, env: {...f.env, SC_LOG:log, ...env}, encoding:'utf8',timeout:25_000,maxBuffer:4*1024*1024 });
    assert.equal(result.status, 0, result.stderr); assert(!/Failed to load extension|Extension error/.test(result.stderr), result.stderr);
    const events=result.stdout.split('\n').filter(Boolean).map(s=>JSON.parse(s)); assert(events.some(e=>e.type==='agent_settled'&&!e.aborted));
    const notes=records(log); assert(!notes.some(e=>e.type==='fixture-error')); assert.equal(notes.filter(e=>e.type==='provider').length,1);
    return { notes, provider:notes.find(e=>e.type==='provider'), incoming:notes.find(e=>e.type==='incoming').files };
  }
  async function rpc(cwd, extra = [], env = {}) {
    const log=join(f.root,`rpc-${++seq}.jsonl`), child=spawn(node,args(true,['--mode','rpc',...extra]),{cwd,env:{...f.env,SC_LOG:log,...env},stdio:['pipe','pipe','pipe']});
    children.add(child); let buffer='', stderr='', serial=0; const events=[], listeners=new Set();
    const timer=setTimeout(()=>child.kill('SIGKILL'),45_000);
    const exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
    child.stdout.setEncoding('utf8'); child.stdout.on('data',s=>{buffer+=s;let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(line){const e=JSON.parse(line);events.push(e);for(const l of listeners)l();}}});
    child.stderr.setEncoding('utf8');child.stderr.on('data',s=>{stderr+=s;});
    const wait=predicate=>new Promise((yes,no)=>{const t=setTimeout(()=>{listeners.delete(poll);no(Error(`RPC timeout: ${stderr} ${JSON.stringify(events.slice(-4))}`));},20_000);const poll=()=>{const value=predicate();if(value){clearTimeout(t);listeners.delete(poll);yes(value);}};listeners.add(poll);poll();});
    async function command(type,data={}) {const id=String(++serial);child.stdin.write(JSON.stringify({id,type,...data})+'\n');const response=await wait(()=>events.find(e=>e.type==='response'&&e.id===id));assert(response.success,JSON.stringify(response));return response.data;}
    async function prompt(message) {const start=events.length;await command('prompt',{message});return wait(()=>events.slice(start).find(e=>e.type==='agent_settled'));}
    async function stop() { child.stdin.end(); const kill=setTimeout(()=>child.kill('SIGKILL'),3000);const result=await exited;clearTimeout(kill);clearTimeout(timer);children.delete(child);assert.equal(result.code,0,stderr);assert(records(log).some(e=>e.type==='shutdown')); }
    await command('get_state'); return {command,prompt,stop,events,notes:()=>records(log)};
  }
  try {
    const base=json(f.p.linked,false), fixed=json(f.p.linked,true);
    check('baseline reproduces leaked HelloFresh owner instructions in actual provider prompt',()=>{
      assert(base.incoming.some(x=>x.path===join(f.owner,'AGENTS.md')&&x.content.includes('SC_HF')));
      assert(base.provider.prompt.includes('SC_HF'));assert(!base.provider.prompt.includes('SC_PERSONAL'));
    });
    check('candidate removes known legacy leak and restores complete personal primary ancestors',()=>{
      assert(!fixed.provider.prompt.includes('SC_HF'));
      ordered(fixed.provider.prompt,['SC_GLOBAL','SC_ROOT','SC_HOME','SC_WORKTREES','SC_BRANCH','SC_PROJECTS','SC_PERSONAL','SC_DOMAIN','SC_REPO_P']);
      assert.equal(occurrences(fixed.provider.prompt,'SC_GLOBAL'),1);assert.equal(occurrences(fixed.provider.prompt,'SC_ROOT'),1);
    });
    console.log(`MEASURE synthetic provider system prompt bytes: baseline=${base.provider.promptBytes}, candidate=${fixed.provider.promptBytes}; transcript bytes: baseline=${base.provider.transcriptBytes}, candidate=${fixed.provider.transcriptBytes}`);
    const redirected=json(f.p.linked,true,[],{GIT_DIR:join(f.other.primary,'.git'),GIT_WORK_TREE:f.other.primary,GIT_COMMON_DIR:join(f.other.primary,'.git'),GIT_INDEX_FILE:join(f.root,'foreign-index'),GIT_PREFIX:'foreign/'});
    check('real CLI ignores foreign Git identity environment overrides',()=>{
      assert(redirected.provider.prompt.includes('SC_DOMAIN'));assert(redirected.provider.prompt.includes('SC_REPO_P'));assert(!redirected.provider.prompt.includes('SC_REPO_Q'));assert(!redirected.provider.prompt.includes('SC_HF'));
    });
    const business=json(join(f.hf.linked,'nested/deep'),true), separate=json(f.other.linked,true);
    check('HelloFresh and separate personal roots on the same branch receive their own instructions',()=>{
      ordered(business.provider.prompt,['SC_PROJECTS','SC_HF','SC_PLATFORM','SC_REPO_HF\n','SC_REPO_HF_NESTED','SC_REPO_HF_OVERRIDE']);
      assert.equal(occurrences(business.provider.prompt,'SC_HF\n'),1);assert(!business.provider.prompt.includes('SC_PERSONAL'));assert(!business.provider.prompt.includes('SC_REPO_HF_SHADOWED'));
      assert(separate.provider.prompt.includes('SC_PERSONAL'));assert(separate.provider.prompt.includes('SC_REPO_Q'));assert(!separate.provider.prompt.includes('SC_DOMAIN'));assert(!separate.provider.prompt.includes('SC_HF'));
    });
    const literal=json(f.p.linked,true,[],{},['--','-nc']);
    check('literal -nc prompt after -- still scopes in the actual CLI',()=>{
      assert(literal.incoming.length > 0);assert(literal.provider.prompt.includes('SC_DOMAIN'));assert(literal.provider.prompt.includes('SC_PERSONAL'));assert(!literal.provider.prompt.includes('SC_HF'));
    });
    for(const opt of ['--no-context-files','-nc']) {
      const off=json(f.hf.linked,true,[opt]);check(`${opt} prevents canonical injection in real CLI`,()=>{assert.deepEqual(off.incoming,[]);assert(!off.provider.prompt.includes('SC_'));});
    }
    unlinkSync(join(f.owner,'AGENTS.md')); f.instructions(f.owner,'SC_OWNER_REGULAR');
    check('unknown regular owner instructions survive in real CLI',()=>{assert(json(f.p.linked,true).provider.prompt.includes('SC_OWNER_REGULAR'));});
    unlinkSync(join(f.owner,'AGENTS.md'));f.instructions(join(f.home,'custom'),'SC_UNKNOWN_SYMLINK');symlinkSync(join(f.home,'custom/AGENTS.md'),join(f.owner,'AGENTS.md'));
    check('unknown owner symlink survives in real CLI',()=>{assert(json(f.p.linked,true).provider.prompt.includes('SC_UNKNOWN_SYMLINK'));});
    unlinkSync(join(f.owner,'AGENTS.md'));symlinkSync(join(f.home,'projects/hellofresh/AGENTS.md'),join(f.owner,'AGENTS.md'));
    const h=await rpc(f.p.linked);
    let session;
    try {
      await h.prompt('SC_FIRST');await h.prompt('SC_SECOND');session=(await h.command('get_state')).sessionFile;
      check('second RPC turn retains one instruction copy with no inherited duplicates',()=>{
        const calls=h.notes().filter(e=>e.type==='provider');assert.equal(calls.length,2);
        for(const call of calls){assert.equal(occurrences(call.prompt,'SC_PERSONAL'),1);assert.equal(occurrences(call.prompt,'SC_REPO_P\n'),1);assert(!call.prompt.includes('SC_HF'));}
        assert.equal(calls[0].prompt,calls[1].prompt);
      });
      f.instructions(join(f.home,'projects/personal/domain'),'SC_DOMAIN_REFRESHED','CLAUDE.md');await h.prompt('SC_REFRESH');
      check('canonical instructions refresh between prompts, effective model system uses new text',()=>{
        const call=h.notes().filter(e=>e.type==='provider').at(-1);assert(call.prompt.includes('SC_DOMAIN_REFRESHED'));assert(!call.prompt.includes('SC_DOMAIN\n'));
      });
    } finally {await h.stop();}
    const resumed=await rpc(f.p.linked,['--session',session]);
    try {
      await resumed.prompt('SC_RESUMED');check('resumed candidate session keeps effective context scoped without duplicates',()=>{
        const call=resumed.notes().find(e=>e.type==='provider');assert.equal(occurrences(call.prompt,'SC_PERSONAL'),1);assert(call.prompt.includes('SC_DOMAIN_REFRESHED'));assert(!call.prompt.includes('SC_HF'));
      });
    } finally {await resumed.stop();}
    const stale=await rpc(f.p.linked,['--session',base.notes.find(e=>e.type==='ready').session]);
    try {
      await stale.prompt('SC_PRE_FIX_SESSION');
      check('pre-fix session replay replaces effective context but retains historical system entries',()=>{
        const call=stale.notes().find(e=>e.type==='provider');assert(!call.prompt.includes('SC_HF'));assert.equal(occurrences(call.prompt,'SC_PERSONAL'),1);
        assert(JSON.stringify(call.systems).includes('SC_HF'), 'Pi history retains the obsolete baseline system, which this extension does not erase');
      });
    } finally {await stale.stop();}
    // A PATH-local failing Git reproduces metadata errors, without damaging real metadata.
    const bin=join(f.root,'failing-bin');put(join(bin,'git'),'#!/bin/sh\nprintf "metadata unavailable\\n" >&2\nexit 73\n');run('chmod',['+x',join(bin,'git')],f.env);
    const broken=await rpc(f.p.linked,[],{PATH:`${bin}:${f.env.PATH}`});
    try {
      const settled=await broken.prompt('SC_METADATA_FAILURE');
      check('metadata failure explicitly aborts before any provider request',()=>{
        assert(settled.aborted);assert(broken.events.some(e=>e.type==='extension_error'&&/Scoped instructions unavailable/.test(e.error)));
        assert.equal(broken.notes().filter(e=>e.type==='provider').length,0);
      });
    } finally {await broken.stop();}
  } finally {
    for(const child of children){if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));}children.delete(child);}
    assert.equal(children.size,0);f.cleanup();assert.equal(readFileSync(candidate,'utf8'),original);
  }
  check('all owned child processes, private worktrees and fixture data removed',()=>{assert.equal(children.size,0);assert(!existsSync(f.root));});
  console.log('LIMIT: effective system prompts are checked. Native append-only transcripts may retain obsolete system text; this extension does not rewrite old sessions.');
  console.log(`Checks: ${checks.length} passed (Pi ${JSON.parse(readFileSync(join(installed,'package.json'),'utf8')).version})`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
