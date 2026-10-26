// Run: bun scripts/bench-status-bar-render.ts [--baseline path] [--output report.json]
// Compile both extensions, then measure their real render methods in installed Node.
// Mock only Pi context, lifecycle, Git, and time. Use the installed TUI width helpers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const candidate = join(repo, "pi/.pi/agent/extensions/status-bar.ts");
const arg = (name: string) => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const root = mkdtempSync(join(tmpdir(), "sb-render-bench-"));
try {
	const baselineArg = arg("--baseline");
	const baseline = baselineArg ? resolve(baselineArg) : join(root, "baseline.ts");
	if (!baselineArg) {
		const result = spawnSync("git", ["show", "HEAD:pi/.pi/agent/extensions/status-bar.ts"], { cwd: repo, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		writeFileSync(baseline, result.stdout);
	}
	const sources = { baseline, candidate };
	const fingerprint = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
	const sourceHashes = Object.fromEntries(Object.entries(sources).map(([name, path]) => [name, fingerprint(path)]));
	for (const [name, path] of Object.entries(sources)) {
		const compiled = await Bun.build({ entrypoints: [path], target: "node", format: "cjs", external: ["*"], write: false });
		assert.ok(compiled.success, compiled.logs.join("\n"));
		writeFileSync(join(root, name + ".cjs"), await compiled.outputs[0].text());
	}
	writeFileSync(join(root, "runner.cjs"), String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createRequire} = require('node:module');
const {Script,createContext} = require('node:vm');
const {promisify} = require('node:util');
const {join} = require('node:path');
const {performance} = require('node:perf_hooks');
const [root,repo] = process.argv.slice(2);
const load = createRequire(join(repo,'scripts/bench-status-bar-render.ts'));
const width = load('@earendil-works/pi-tui').visibleWidth;
function host(source, count) {
  let now=0, footer, activeTimers=0, gitCalls=0, reads=0, renders=0;
  const handlers=new Map();
  const branch=Array.from({length:count},(_,i)=>({type:'message',id:String(i),message:{role:'assistant',stopReason:'stop',
    usage:{input:1000,output:2000,cacheRead:4000,cacheWrite:100,cost:{total:0.00123}}}}));
  const execFile=(cmd,args,options,callback)=>{
    gitCalls++;
    const out=args[0]==='rev-parse'?'/repo/worktree/dotfiles\n/repo/dotfiles/.git\n/repo/dotfiles/.git/worktrees/a\n':'# branch.ab +2 -3\n1 .M file\n';
    queueMicrotask(()=>callback(null,out,''));
  };
  execFile[promisify.custom]=(cmd,args,opts)=>new Promise((resolve,reject)=>execFile(cmd,args,opts,(err,stdout,stderr)=>err?reject(err):resolve({stdout,stderr})));
  class Clock extends Date {static now(){return now;}}
  const module={exports:{}};
  new Script(source).runInContext(createContext({module,exports:module.exports,console,Date:Clock,
    setInterval:()=>{activeTimers++;return {unref(){}}},clearInterval:()=>{activeTimers--},
    require:(name)=>name==='node:child_process'?{execFile}:name==='node:fs'?{existsSync:()=>true,readFileSync:()=>{reads++;return '{}'}}:
      name==='@earendil-works/pi-coding-agent'?{copyToClipboard:async()=>{}}:load(name)}));
  module.exports.default({on:(name,fn)=>handlers.set(name,fn),registerCommand(){},getThinkingLevel:()=> 'high'});
  const theme={fg:(color,text)=>'\x1b[38;5;'+(color.length+230)+'m'+text+'\x1b[0m',bold:text=>'\x1b[1m'+text+'\x1b[22m',getThinkingBorderColor:()=>text=>text};
  const statuses=new Map([['meter','\x1b[32mblackhole obs ▕▏▏▏\x1b[0m']]);
  let modelName='GPT-6.1 Sol';
  const ctx={mode:'tui',hasUI:true,cwd:'/repo/worktree/dotfiles',model:{id:'gpt-6.1-sol',get name(){return modelName},provider:'ai-model-router'},
    ui:{setFooter:factory=>{footer=factory?.({requestRender(){renders++}},theme,{getGitBranch:()=> 'feature-example',getExtensionStatuses:()=>statuses,onBranchChange:()=>()=>{}})},notify(){}},
    sessionManager:{getSessionId:()=> '12345678-abcd-4321-8765-0123456789ab',getSessionFile:()=>'/test.jsonl',getSessionName:()=> 'Benchmark session',getBranch:()=>branch},
    getContextUsage:()=>({tokens:30000,contextWindow:128000,percent:23.4375})};
  const stats=()=>({gitCalls,reads,renders,activeTimers});
  return {ctx,stats,fire:async name=>{await handlers.get(name)?.({},ctx);for(let i=0;i<12;i++)await Promise.resolve()},
    render:cols=>footer.render(cols),clock:t=>{now=t},model:name=>{modelName=name}};
}
const median=values=>{const x=[...values].sort((a,b)=>a-b);return x[Math.floor(x.length/2)]};
const summarize=values=>({medianUs:median(values),madUs:median(values.map(x=>Math.abs(x-median(values)))),p95BatchMeanUs:[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]});
(async()=>{
  const sources=Object.fromEntries(['baseline','candidate'].map(n=>[n,fs.readFileSync(join(root,n+'.cjs'),'utf8')]));
  const scenarios=[{name:'warm idle',history:10,active:false,changing:false},{name:'working timer',history:500,active:true,changing:true},
    {name:'long history',history:5000,active:false,changing:false},{name:'crowded model',history:500,active:true,changing:true,long:true}];
  const results=[];
  for(const scenario of scenarios){
    const hosts=Object.fromEntries(Object.entries(sources).map(([n,source])=>[n,host(source,scenario.history)]));
    for(const h of Object.values(hosts)){await h.fire('session_start');if(scenario.active)await h.fire('before_agent_start');if(scenario.long)h.model('Very long model name '.repeat(20));}
    for(const cols of [60,80,120,160]){
      const samples={baseline:[],candidate:[]};
      const iterations=scenario.history>=5000?300:1000;
      for(const h of Object.values(hosts))for(let i=0;i<300;i++)h.render(cols);
      for(let repeat=0;repeat<9;repeat++)for(const name of repeat%2?['candidate','baseline']:['baseline','candidate']){
        const h=hosts[name];h.clock(repeat*1000);
        const before=h.stats();
        const start=performance.now();
        for(let i=0;i<iterations;i++){if(scenario.changing)h.clock(repeat*1000+Math.floor(i/100)*1000);h.render(cols);}
        const us=(performance.now()-start)*1000/iterations;
        samples[name].push(us);
        assert.deepEqual(h.stats(),before,'render must not do I/O, create timers or request paint');
        assert(h.render(cols).every(row=>width(row)<=cols));
      }
      const baseline=summarize(samples.baseline),candidate=summarize(samples.candidate);
      results.push({scenario:scenario.name,history:scenario.history,cols,iterations,repeats:9,baseline,candidate,deltaUs:candidate.medianUs-baseline.medianUs,deltaPercent:(candidate.medianUs/baseline.medianUs-1)*100});
    }
    for(const h of Object.values(hosts)){await h.fire('session_shutdown');assert.equal(h.stats().activeTimers,0)}
  }
  console.log(JSON.stringify({runtime:process.version,platform:process.platform,benchmark:'actual footer render in Node VM, real TUI width utilities, mocked context/lifecycle/I/O',
    units:'microseconds per render, p95 across batch means, not individual render tail latency',jitWarmup:300,rotatingOrder:true,results},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
`);
	const measured = spawnSync("node", [join(root, "runner.cjs"), root, repo], { cwd: repo, encoding: "utf8", timeout: 180000 });
	assert.equal(measured.status, 0, measured.stderr);
	const report = JSON.parse(measured.stdout);
	for (const [name, path] of Object.entries(sources)) assert.equal(fingerprint(path), sourceHashes[name], `Source changed during measurement: ${path}`);
	report.sources = Object.fromEntries(Object.entries(sources).map(([name, path]) => [name, { path, sha256: sourceHashes[name] }]));
	if (arg("--output")) writeFileSync(resolve(arg("--output")!), JSON.stringify(report, null, 2) + "\n");
	console.log(JSON.stringify(report, null, 2));
} finally {
	rmSync(root, { recursive: true, force: true });
}
