#!/usr/bin/env node
// Isolated integration tests. No live package writes or process-name kills.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { patch, inspect, copyOriginalPackage, baselineDir, DEFAULT_CACHE, sha, VERSION, REVISION } from './patch-context-mode.mjs';

const source = process.argv[2] ?? path.join(os.homedir(), '.pi/agent/npm/node_modules/context-mode');
const sourceCache = process.argv[3] ?? DEFAULT_CACHE;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-resource-test-'));
const copy = path.join(temp, 'context-mode');
const cache = path.join(temp, 'cache');
const clients = new Set(), executors = new Set(), subprocesses = new Set();
const passed = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (fn()) return; await sleep(25); }
  throw new Error('Test condition deadline exceeded');
}
function data(name) { return path.join(temp, name); }
function pidFile(name) { return Number(fs.readFileSync(data(name), 'utf8').trim()); }
async function gone(name) { await until(() => !alive(pidFile(name))); }
async function test(name, run) { await run(); passed.push(name); console.log('PASS ' + name); }
function launch(script, env = {}) {
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  subprocesses.add(child);
  const deadline = setTimeout(() => child.kill('SIGKILL'), 30_000);
  child.once('close', () => { clearTimeout(deadline); subprocesses.delete(child); });
  return child;
}
const suiteDeadline = setTimeout(() => {
  for (const c of clients) c.shutdown(new Error('Test suite deadline'));
  for (const e of executors) e.cleanupBackgrounded(true);
  for (const c of subprocesses) c.kill('SIGKILL');
}, 240_000);

try {
  const sourceState = copyOriginalPackage(source, copy, sourceCache);
  // npm resolution stays real, but test state and patch baselines remain private.
  const deps = path.join(temp, 'node_modules');
  fs.symlinkSync(path.join(path.dirname(source)), deps, 'dir');
  if (fs.existsSync(path.join(source, 'node_modules'))) fs.symlinkSync(path.join(source, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
  const baseline = inspect(copy).current;
  await test('read-only default check and unknown version refusal', async () => {
    assert.equal((await patch({ packageDir: copy, cacheDir: cache })).state, 'original');
    assert.equal(fs.existsSync(cache), false);
    const original = fs.readFileSync(path.join(copy, 'package.json'));
    const meta = JSON.parse(original); meta.version = '9.9.9';
    fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify(meta));
    await assert.rejects(patch({ mode: 'apply', packageDir: copy, cacheDir: cache }), /Unknown/);
    assert.equal(fs.existsSync(cache), false);
    fs.writeFileSync(path.join(copy, 'package.json'), original);
  });
  await test('drift refused before writes', async () => {
    const file = path.join(copy, 'build/executor.js'), original = fs.readFileSync(file);
    fs.appendFileSync(file, '\n// drift\n');
    const drift = sha(fs.readFileSync(file));
    await assert.rejects(patch({ mode: 'apply', packageDir: copy, cacheDir: cache }), /drift/);
    assert.equal(sha(fs.readFileSync(file)), drift);
    assert.equal(fs.existsSync(cache), false);
    fs.writeFileSync(file, original);
  });
  await test('apply with reproducible Bun build and real MCP execution plus SQLite smoke', async () => {
    const result = await patch({ mode: 'apply', packageDir: copy, cacheDir: cache });
    assert.equal(result.smoke, 'passed');
    const manifest = JSON.parse(fs.readFileSync(path.join(copy, '.pi-resource-patch.json')));
    assert.equal(manifest.patchVersion, 1); assert.equal(manifest.revision, REVISION); assert.equal(manifest.version, VERSION);
    for (const [name, hash] of Object.entries(manifest.files)) assert.equal(sha(fs.readFileSync(path.join(copy, name))), hash);
    assert.equal(fs.statSync(cache).mode & 0o777, 0o700);
  });
  await test('patched-source baseline reconstruction leaves source intact', async () => {
    const destination=data('reconstructed');
    copyOriginalPackage(copy,destination,cache);
    assert.deepEqual(inspect(destination).current,baseline);
    assert.equal(inspect(copy).state,'patched');
    const baselineFile=path.join(baselineDir(cache),'build/executor.js');
    const bytes=fs.readFileSync(baselineFile);fs.appendFileSync(baselineFile,'// drift');
    assert.throws(()=>copyOriginalPackage(copy,data('bad-reconstructed'),cache),/baseline drift/);
    fs.writeFileSync(baselineFile,bytes);
  });
  await test('exclusive cache lock refuses concurrent apply and releases on success', async () => {
    const original=data('lock-original');copyOriginalPackage(copy,original,cache);
    fs.symlinkSync(path.join(source,'node_modules'),path.join(original,'node_modules'),'dir');
    const running=patch({mode:'apply',packageDir:original,cacheDir:cache});
    await assert.rejects(patch({mode:'apply',packageDir:original,cacheDir:cache}),/lock exists/);
    await running;
    assert.equal(fs.readdirSync(cache).filter(n=>n.startsWith('.lock-')).length,0);
    await patch({mode:'restore',packageDir:original,cacheDir:cache});
  });
  await test('idempotent apply and exact manifest validation', async () => {
    const original = fs.readFileSync(path.join(copy, '.pi-resource-patch.json'));
    assert.equal((await patch({ mode: 'apply', packageDir: copy, cacheDir: cache })).unchanged, true);
    fs.appendFileSync(path.join(copy, '.pi-resource-patch.json'), ' ');
    await assert.rejects(patch({ packageDir: copy }), /marker drift/);
    fs.writeFileSync(path.join(copy, '.pi-resource-patch.json'), original);
    const file = path.join(copy, 'build/executor.js'), bytes = fs.readFileSync(file);
    fs.appendFileSync(file, '\n// drift');
    await assert.rejects(patch({ mode: 'restore', packageDir: copy, cacheDir: cache }), /drift/);
    fs.writeFileSync(file, bytes);
  });
  await test('direct-parent fixture removes ps probes without changing owner watch cadence', async () => {
    const bin = data('fake-bin'); fs.mkdirSync(bin);
    const fakePs = path.join(bin,'ps');
    fs.writeFileSync(fakePs, '#!/bin/sh\nprintf "probe\\n" >> "$CM_PS_COUNT"\nprintf "4321\\n"\n', {mode:0o700});
    const script = data('lifecycle-probe.mjs');
    fs.writeFileSync(script, `const m=await import(process.env.MODULE_URL);
let calls=0;const injected=m.makeDefaultIsParentAlive({getPpid:()=>1234,readGrandparentPpid:()=>{calls++;return 4321;}});
let owner=1234;const ownership=m.makeDefaultIsParentAlive({getPpid:()=>owner,readGrandparentPpid:()=>NaN});
if(!ownership())throw new Error('live owner rejected');owner=1;if(ownership())throw new Error('dead owner accepted');
const timer=setInterval(m.makeDefaultIsParentAlive(),1000);
const injectedTimer=setInterval(injected,1000);
await new Promise(r=>setTimeout(r,5100));clearInterval(timer);clearInterval(injectedTimer);
console.log(JSON.stringify({calls,interval:m.lifecycleGuardIntervalForEnv({CONTEXT_MODE_BRIDGE_DEPTH:'1'})}));`);
    const originalFixture=data('original-fixture');
    copyOriginalPackage(copy,originalFixture,cache);
    fs.symlinkSync(path.join(source,'node_modules'),path.join(originalFixture,'node_modules'),'dir');
    const counts = [];
    for (const [pkg,flag] of [[data('original-fixture'),'0'],[copy,'0'],[copy,'1']]) {
      const countFile = data('ps-' + counts.length); fs.writeFileSync(countFile,'');
      const result = JSON.parse(execFileSync(process.execPath,[script], { timeout:15000,killSignal:'SIGKILL',encoding:'utf8',env:{...process.env,
        PATH:bin+path.delimiter+process.env.PATH,CM_PS_COUNT:countFile,CONTEXT_MODE_DIRECT_PARENT:flag,
        MODULE_URL:pathToFileURL(path.join(pkg,'build/lifecycle.js')).href} }));
      assert(result.calls >= 4 && result.calls <= 6); assert.equal(result.interval,1000);
      counts.push(fs.readFileSync(countFile,'utf8').trim().split('\n').filter(Boolean).length);
    }
    assert(counts[0]>=5 && counts[1]>=5); assert.equal(counts[2],0);
    console.log(JSON.stringify({fixtureWindowMs:5100,injectedBefore:6,psBefore:counts[0],wrapperAfter:counts[1],directParentAfter:counts[2]}));
  });
  const { MCPStdioClient, bootstrapMCPTools, toolBudget } = await import(pathToFileURL(path.join(copy, 'build/adapters/pi/mcp-bridge.js')));
  const { PolyglotExecutor } = await import(pathToFileURL(path.join(copy, 'build/executor.js')));
  const fake = data('fake.mjs');
  fs.writeFileSync(fake, `import fs from 'node:fs'; import readline from 'node:readline';
const log = obj => fs.appendFileSync(process.env.LOG, JSON.stringify(obj)+'\\n');
log({pid:process.pid,event:'start'});
const deadline=setTimeout(()=>process.exit(0),25000);
process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),50));
const send=(id,result,error)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result,error})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); log({pid:process.pid,...m});
 if(m.method==='initialize') {
  if(process.env.MODE==='init') send(m.id,null,{message:'init failure'});
  else send(m.id,{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}});
 } else if(m.method==='tools/list') {
  if(process.env.MODE==='list') send(m.id,null,{message:'list failure'});
  else send(m.id,{tools:[{name:'ctx_execute',inputSchema:{type:'object'}}]});
 } else if(m.method==='tools/call' && m.params.arguments?.code !== 'hang') send(m.id,{content:[{type:'text',text:'ok'}]});
});`);
  const fakeEnv = mode => ({ ...process.env, CONTEXT_MODE_BRIDGE_DEPTH: '0', MODE: mode, LOG: data('fake-' + mode + '.jsonl'), CONTEXT_MODE_BRIDGE_IDLE_MS: '0' });
  const makeClient = mode => { const c = new MCPStdioClient(fake, fakeEnv(mode), process.execPath); clients.add(c); return c; };
  const readLog = mode => fs.readFileSync(data('fake-' + mode + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  await test('default and explicit RPC budgets, conservative batch waves and invalid timeout rejection', async () => {
    assert.deepEqual(toolBudget('ctx_execute'), { params: { timeout: 120000 }, timeout: 130000 });
    assert.equal(toolBudget('ctx_execute', { timeout: 600000 }).timeout, 610000);
    assert.equal(toolBudget('ctx_execute_file').params.timeout, 120000);
    assert.equal(toolBudget('ctx_search').timeout, 120000);
    assert.equal(toolBudget('ctx_batch_execute', { timeout: 50, concurrency: 2, commands: [1,2,3,4,5] }).timeout, 30150);
    assert.equal(toolBudget('ctx_batch_execute', { timeout: 50, concurrency: 1, commands: [1,2,3] }).timeout, 10050);
    for (const timeout of [0, -1, Infinity, NaN, 2147483647]) assert.throws(() => toolBudget('ctx_execute', { timeout }), /timeout/);
    assert.throws(() => toolBudget('ctx_execute', { background: true }), /explicit/);
  });
  await test('Pi execute forwards abort, cancels request ID, rejects sibling calls, then safely respawns', async () => {
    const registered = [];
    const handle = await bootstrapMCPTools({ registerTool: t => registered.push(t) }, fake, { env: fakeEnv('cancel'), _resolveJsRuntime: () => process.execPath });
    const c = handle.client; clients.add(c); const old = c.child;
    const controller = new AbortController();
    const a = registered[0].execute('id', { code: 'hang' }, controller.signal);
    const b = c.callTool('ctx_execute', { code: 'hang' });
    const outcomes = Promise.allSettled([a,b]);
    await until(() => c.pending.size === 2);
    controller.abort();
    const results = await outcomes;
    assert(results.every(r => r.status === 'rejected' && /cancelled/.test(r.reason.message)));
    assert.equal(c.pending.size, 0);
    assert.equal((await c.callTool('ctx_execute', {})).content[0].text, 'ok');
    const replacement = c.child;
    c.onExit(old); assert.equal(c.child, replacement); assert.equal(c.exited, false);
    await until(() => readLog('cancel').some(m => m.method === 'notifications/cancelled'));
    const cancellation = readLog('cancel').find(m => m.method === 'notifications/cancelled');
    assert.equal(typeof cancellation.params.requestId, 'number');
    assert.equal(c._spawnEnv.CONTEXT_MODE_DIRECT_PARENT, '1');
    c.shutdown();
  });
  await test('already-aborted calls do not respawn, concurrent calls share one respawn', async () => {
    const c = makeClient('concurrent'); c.start(); await c.initialize(); c.shutdown();
    const controller = new AbortController(); controller.abort();
    await assert.rejects(c.callTool('ctx_execute', {}, controller.signal), /aborted/); assert.equal(c.child, null);
    await Promise.all([c.callTool('ctx_execute', {}), c.callTool('ctx_execute', {})]);
    const starts = readLog('concurrent').filter(m => m.event === 'start'); assert.equal(starts.length, 2);
    c.shutdown();
  });
  await test('shutdown during respawn does not poison the next replacement', async () => {
    const c = makeClient('race'); c.start(); await c.initialize(); c.shutdown();
    const a = c.callTool('ctx_execute', {}), outcome = Promise.allSettled([a]);
    await until(() => c.child !== null);
    c.shutdown(); assert.equal((await outcome)[0].status, 'rejected');
    await until(() => c.respawnPromise === null);
    assert.equal((await c.callTool('ctx_execute', {})).content[0].text, 'ok');
    c.shutdown();
  });
  await test('RPC timeout reclaims bridge and clears listeners and pending map', async () => {
    const c = makeClient('timeout'); c.start(); await c.initialize();
    const controller = new AbortController();
    await assert.rejects(c.request('tools/call', { name: 'ctx_execute', arguments: { code: 'hang' } }, 80, controller.signal), /timeout/);
    assert.equal(c.pending.size, 0); assert.equal(c.child, null);
    const success = makeClient('listeners'); success.start(); await success.initialize();
    let adds = 0, removes = 0;
    const signal = new AbortController().signal;
    const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...a) => { adds++; return add(...a); };
    signal.removeEventListener = (...a) => { removes++; return remove(...a); };
    await success.callTool('ctx_execute', {}, signal); assert.equal(adds, removes);
    assert.equal(readLog('listeners').find(m => m.method==='tools/call').params.arguments.timeout,120000);
    success.shutdown();
  });
  await test('final initialize, tools/list and tool registration failures close every child', async () => {
    for (const mode of ['init','list','register']) {
      await assert.rejects(bootstrapMCPTools({ registerTool: () => { throw new Error('registration failure'); } }, fake, {
        env: fakeEnv(mode), _resolveJsRuntime: () => process.execPath,
      }));
      await until(() => readLog(mode).filter(m => m.event === 'start').every(m => !alive(m.pid)));
      assert.equal(readLog(mode).filter(m => m.event === 'start').length, mode === 'init' ? 3 : 1);
    }
  });
  const makeExecutor = () => {
    const e = new PolyglotExecutor({ projectRoot: temp, runtimes: { shell: '/bin/sh', javascript: process.execPath } });
    executors.add(e); return e;
  };
  await test('executor omitted timeout returns normally, invalid timeouts and background omission rejected', async () => {
    const e = makeExecutor(); assert.equal((await e.execute({ language: 'shell', code: 'printf hello' })).stdout, 'hello');
    for (const timeout of [0,-1,Infinity,NaN]) await assert.rejects(e.execute({ language: 'shell', code: ':', timeout }), /timeout/);
    await assert.rejects(e.execute({ language: 'shell', code: ':', background: true }), /explicit/);
    assert.equal((await e.execute({ language: 'javascript', code: 'console.log("js-ok")', timeout: 5000 })).stdout.trim(), 'js-ok');
    assert.equal((await e.executeFile({ path: 'fake.mjs', language: 'shell', code: 'printf "%s" "$FILE_CONTENT"', timeout: 1000 })).exitCode, 0);
  });
  await test('omitted executor timeout installs a real 120000ms deadline', async () => {
    const script = data('default-deadline.mjs');
    fs.writeFileSync(script, `import {PolyglotExecutor} from ${JSON.stringify(pathToFileURL(path.join(copy,'build/executor.js')).href)};
const original=setTimeout;const delays=[];globalThis.setTimeout=(fn,ms,...args)=>{delays.push(ms);return original(fn,ms===120000?100:ms,...args)};
const e=new PolyglotExecutor({projectRoot:${JSON.stringify(temp)},runtimes:{shell:'/bin/sh'}});
process.on('exit',()=>e.cleanupBackgrounded(true));
try{const result=await e.execute({language:'shell',code:'sleep 20'});console.log(JSON.stringify({delays,timedOut:result.timedOut}));}finally{e.cleanupBackgrounded(true)}`);
    const c = launch(script); let stdout=''; c.stdout.on('data',b=>stdout+=b); const [exit]=await once(c,'close');
    assert.equal(exit,0); const result=JSON.parse(stdout); assert.equal(result.timedOut,true); assert(result.delays.includes(120000));
  });
  await test('compilation shares timeout and cancellation group ownership', async () => {
    const bin=data('compiler-bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin,'rustc'), `#!/bin/sh\ntrap '' TERM\necho $$ > '${data('compiler.pid')}'\nsleep 20\n`, {mode:0o700});
    const script=data('compile-test.mjs');
    fs.writeFileSync(script, `import {PolyglotExecutor} from ${JSON.stringify(pathToFileURL(path.join(copy,'build/executor.js')).href)};
const e=new PolyglotExecutor({projectRoot:${JSON.stringify(temp)},runtimes:{rust:true,shell:'/bin/sh'}});
process.on('exit',()=>e.cleanupBackgrounded(true));
try{const result=await e.execute({language:'rust',code:'fn main(){}',timeout:3000});console.log(JSON.stringify(result));}finally{e.cleanupBackgrounded(true)}`);
    const c=launch(script,{PATH:bin+path.delimiter+process.env.PATH});let stdout='';c.stdout.on('data',b=>stdout+=b);const [exit]=await once(c,'close');
    assert.equal(exit,0);assert.equal(JSON.parse(stdout).timedOut,true);
    assert.ok(fs.existsSync(data('compiler.pid')), `compiler fixture never started: ${stdout}`);
    await gone('compiler.pid');
  });
  await test('successful Rust compilation retains its sandbox until execution finishes', async () => {
    const e = new PolyglotExecutor({ projectRoot: temp, runtimes: { rust: true, shell: '/bin/sh' } });
    executors.add(e);
    const result = await e.execute({ language: 'rust', code: 'fn main(){println!("rust-resource-ok");}', timeout: 10000 });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'rust-resource-ok');
    assert.equal(result.timedOut, false);
    const failed = await e.execute({ language: 'rust', code: 'not valid rust', timeout: 10000 });
    assert.notEqual(failed.exitCode, 0); assert.match(failed.stderr, /Compilation failed/);
  });
  await test('bounded timeout kills an observed stubborn foreground group', async () => {
    const e = makeExecutor();
    // macOS endpoint checks can delay exec beyond a few hundred milliseconds.
    // Prove the fixture started before treating its absence as cleanup success.
    const running = e.execute({ language: 'shell', code: `trap '' TERM; echo $$ > '${data('stubborn.pid')}'; sleep 20`, timeout: 3000 });
    await until(() => fs.existsSync(data('stubborn.pid')));
    const result = await running;
    assert.equal(result.timedOut, true); await gone('stubborn.pid');
  });
  await test('root exits while descendant holds pipes, deadline kills the surviving group', async () => {
    const e = makeExecutor();
    const running = e.execute({ language: 'shell', code: `sh -c 'trap "" TERM; echo $$ > "${data('descendant.pid')}"; sleep 20' &\nexit 0`, timeout: 3000 });
    await until(() => fs.existsSync(data('descendant.pid')));
    const result = await running;
    assert.equal(result.timedOut, true); await gone('descendant.pid');
  });
  await test('descendant turnover stays owned through foreground timeout and background cleanup', async () => {
    for (const background of [false, true]) {
      const name = background ? 'turnover-bg' : 'turnover-fg';
      const a = data(name + '-a.mjs'), b = data(name + '-b.mjs');
      fs.writeFileSync(b, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(data(name + '.pid'))},String(process.pid));setTimeout(()=>process.exit(0),12000);`);
      fs.writeFileSync(a, `import {spawn} from 'node:child_process';setTimeout(()=>{spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(b)}],{stdio:'inherit'});setTimeout(()=>process.exit(0),150);},600);`);
      const e = makeExecutor();
      const running = e.execute({ language: 'shell', code: `'${process.execPath}' '${a}' &\nexit 0`, timeout: 3500, background });
      await until(() => fs.existsSync(data(name + '.pid')));
      const pid = pidFile(name + '.pid');
      try {
        const result = await running;
        assert.equal(result.timedOut, true);
        if (background) { assert.equal(result.backgrounded, true); assert.equal(alive(pid), true); e.cleanupBackgrounded(true); }
        await gone(name + '.pid');
      } finally { if (alive(pid)) process.kill(pid, 'SIGKILL'); }
    }
  });
  await test('group leader owns cleanup when executor exits without explicit shutdown', async () => {
    const name = 'owner-exit';
    const script = data(name + '.mjs');
    fs.writeFileSync(script, `import {PolyglotExecutor} from ${JSON.stringify(pathToFileURL(path.join(copy,'build/executor.js')).href)};
const e=new PolyglotExecutor({projectRoot:${JSON.stringify(temp)},runtimes:{shell:'/bin/sh'}});
await e.execute({language:'shell',code:${JSON.stringify(`trap '' TERM; echo $$ > '${data(name + '.pid')}'; sleep 20`)},timeout:500,background:true});
while(!(await import('node:fs')).existsSync(${JSON.stringify(data(name + '.pid'))}))await new Promise(r=>setTimeout(r,25));
process.exit(0);`);
    const c = launch(script); await once(c, 'close'); await gone(name + '.pid');
  });
  await test('group leader reclaims workload after hard owner death', async () => {
    const script=data('hard-owner.mjs');
    fs.writeFileSync(script, `import {PolyglotExecutor} from ${JSON.stringify(pathToFileURL(path.join(copy,'build/executor.js')).href)};
const e=new PolyglotExecutor({projectRoot:${JSON.stringify(temp)},runtimes:{shell:'/bin/sh'}});
await e.execute({language:'shell',code:${JSON.stringify(`trap '' TERM; echo $$ > '${data('hard-owner.pid')}'; sleep 20`)},timeout:500,background:true});
setTimeout(()=>process.exit(0),20000);`);
    const c=launch(script);
    await until(()=>fs.existsSync(data('hard-owner.pid')));
    c.kill('SIGKILL');await once(c,'close');await gone('hard-owner.pid');
  });
  await test('executor preserves stdin EOF, exit codes and reclaims redirected descendants', async () => {
    const e = makeExecutor();
    const eof = await e.execute({language:'shell',code:'if IFS= read -r x; then exit 9; else printf eof; fi',timeout:2000});
    assert.equal(eof.exitCode,0); assert.equal(eof.stdout,'eof');
    const fail = await e.execute({language:'shell',code:'printf err >&2; exit 7',timeout:2000});
    assert.equal(fail.exitCode,7); assert.equal(fail.stderr,'err');
    const result = await e.execute({ language:'shell', code:`sh -c 'echo $$ > "${data('redirected.pid')}"; sleep 20' >/dev/null 2>&1 &\nwhile [ ! -s '${data('redirected.pid')}' ]; do sleep .02; done\nexit 0`, timeout:3000 });
    assert.equal(result.exitCode,0); await gone('redirected.pid');
  });
  await test('graceful cleanup includes foreground, escalates stubborn background and clears ownership', async () => {
    const e = makeExecutor();
    const foreground = e.execute({ language: 'shell', code: `trap '' TERM; echo $$ > '${data('foreground.pid')}'; sleep 20`, timeout: 10000 });
    await until(() => fs.existsSync(data('foreground.pid')));
    const background = await e.execute({ language: 'shell', code: `trap '' TERM; echo $$ > '${data('background.pid')}'; sleep 20`, timeout: 300, background: true });
    assert.equal(background.backgrounded, true);
    await until(() => fs.existsSync(data('background.pid')));
    e.cleanupBackgrounded(); await foreground;
    await gone('foreground.pid'); await gone('background.pid');
    e.cleanupBackgrounded(true);
  });
  await test('graceful TERM reaches the workload rather than inheriting leader immunity', async () => {
    const script=data('term-handler.mjs');
    fs.writeFileSync(script,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(data('term-handler.pid'))},String(process.pid));process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(data('term-handler.seen'))},'term');process.exit(0);});setTimeout(()=>process.exit(0),15000);`);
    const e=makeExecutor();
    const running=e.execute({language:'javascript',code:fs.readFileSync(script,'utf8'),timeout:500,background:true});
    await until(()=>fs.existsSync(data('term-handler.pid')));
    await running;
    e.cleanupBackgrounded();
    await until(()=>fs.existsSync(data('term-handler.seen')));
    assert.equal(fs.readFileSync(data('term-handler.seen'),'utf8'),'term');await gone('term-handler.pid');
  });
  await test('workload INT and QUIT handlers survive asynchronous launcher', async () => {
    const e=makeExecutor();
    for(const signal of ['INT','QUIT']){
      const result=await e.execute({language:'shell',code:`trap 'printf handled' ${signal}; kill -${signal} $$; printf completed`,timeout:3000});
      assert.equal(result.exitCode,0,result.stderr);assert.equal(result.stdout,'handledcompleted');
    }
  });
  await test('process exit path directly kills owned execution groups', async () => {
    const script = data('exit-owner.mjs');
    fs.writeFileSync(script, `import {PolyglotExecutor} from ${JSON.stringify(pathToFileURL(path.join(copy,'build/executor.js')).href)};
const e=new PolyglotExecutor({projectRoot:${JSON.stringify(temp)},runtimes:{shell:'/bin/sh'}});
process.on('exit',()=>e.cleanupBackgrounded(true));
await e.execute({language:'shell',code:${JSON.stringify(`trap '' TERM; echo $$ > '${data('exit.pid')}'; sleep 20`)},timeout:300,background:true});
while(!(await import('node:fs')).existsSync(${JSON.stringify(data('exit.pid'))}))await new Promise(r=>setTimeout(r,25));
process.exit(0);`);
    const c = launch(script); await once(c, 'close'); await gone('exit.pid');
  });
  await test('server timeout schemas reject zero and background without explicit timeout', async () => {
    const home=data('validation-home');fs.mkdirSync(path.join(home,'.pi'),{recursive:true});
    const c=new MCPStdioClient(path.join(copy,'server.bundle.mjs'),{...process.env,HOME:home,PI_CONFIG_DIR:path.join(home,'.pi'),
      CONTEXT_MODE_PROJECT_DIR:temp,CONTEXT_MODE_PLATFORM:'pi',CONTEXT_MODE_BRIDGE_IDLE_MS:'0'},process.execPath);
    clients.add(c);c.start();await c.initialize();
    for(const args of [{language:'shell',code:':',timeout:0},{language:'shell',code:':',background:true}]) {
      const result=await c.request('tools/call',{name:'ctx_execute',arguments:args},15000);
      assert.equal(result.isError,true);
    }
    const tools=await c.listTools();
    const schema=tools.find(t=>t.name==='ctx_execute').inputSchema.properties.timeout;
    assert.equal(schema.exclusiveMinimum,0);assert.equal(schema.maximum,2147483647);
    c.shutdown();
  });
  await test('real bundled MCP cancellation kills active foreground and background execution groups', async () => {
    const home = data('real-home'); fs.mkdirSync(path.join(home,'.pi'), { recursive: true });
    const c = new MCPStdioClient(path.join(copy,'server.bundle.mjs'), { ...process.env, HOME: home, PI_CONFIG_DIR:path.join(home,'.pi'),
      CONTEXT_MODE_PROJECT_DIR:temp, CONTEXT_MODE_PLATFORM:'pi', CONTEXT_MODE_BRIDGE_IDLE_MS:'0' }, process.execPath);
    clients.add(c); c.start(); await c.initialize();
    const a=data('real-bg-a.mjs'),b=data('real-bg-b.mjs');
    fs.writeFileSync(b,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(data('real-bg.pid'))},String(process.pid));setTimeout(()=>process.exit(0),15000);`);
    fs.writeFileSync(a,`import {spawn} from 'node:child_process';setTimeout(()=>{spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(b)}],{stdio:'inherit'});setTimeout(()=>process.exit(0),150);},500);`);
    await c.callTool('ctx_execute', { language:'shell', code:`'${process.execPath}' '${a}' &\nexit 0`, timeout:1500, background:true });
    await until(()=>fs.existsSync(data('real-bg.pid')));
    const controller = new AbortController();
    const running = c.callTool('ctx_execute', { language:'shell', code:`trap '' TERM; echo $$ > '${data('real-fg.pid')}'; sleep 20`, timeout:10000 }, controller.signal);
    const outcome = Promise.allSettled([running]);
    await until(() => fs.existsSync(data('real-fg.pid')));
    controller.abort(); assert.equal((await outcome)[0].status, 'rejected');
    await gone('real-bg.pid'); await gone('real-fg.pid');
  });
  await test('real Pi host loads v2 guard and nested context tools from isolated package', async () => {
    for(const extra of [[], ['--context-mode']]) {
      const result=execFileSync(process.execPath,[path.resolve('scripts/test-resource-budget-live.mjs'),'--package-dir',copy,...extra],{
        encoding:'utf8',timeout:65000,killSignal:'SIGKILL',maxBuffer:1000000,
      });
      assert.match(result,/PASS real Pi nested tool/);
    }
  });
  await test('restore preserves exact originals, repeated restore is read-only', async () => {
    await patch({ mode:'restore', packageDir:copy, cacheDir:cache });
    assert.deepEqual(inspect(copy).current, baseline);
    assert.equal((await patch({ mode:'restore', packageDir:copy, cacheDir:cache })).unchanged, true);
    assert.deepEqual(inspect(source).current, sourceState.current);
  });
  console.log(JSON.stringify({ passed: passed.length, version: VERSION, revision: REVISION, livePackage: 'unchanged' }));
} finally {
  clearTimeout(suiteDeadline);
  for (const c of clients) c.shutdown();
  for (const e of executors) e.cleanupBackgrounded(true);
  for (const c of subprocesses) c.kill('SIGKILL');
  await sleep(600);
  fs.rmSync(temp, { recursive:true, force:true });
}
