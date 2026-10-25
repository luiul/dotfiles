#!/usr/bin/env node
// Real Pi RPC and nested tools with a local stream fixture. No network model call.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 1 && args[0] === '--context-mode', 'Unknown test argument');
const realContext = args[0] === '--context-mode';
const dir = mkdtempSync(join(tmpdir(), 'resource-budget-live-'));
const probe = join(dir, 'probe.ts');
writeFileSync(probe, `import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
export default function(pi) {
 let calls=0;const inputs=[];
 pi.on('tool_call',event=>{if(event.toolName==='ctx_execute')inputs.push({...event.input});});
 pi.registerProvider('resource-fixture',{baseUrl:'http://fixture.invalid',apiKey:'fixture',api:'resource-fixture',
  models:[{id:'resource-fixture',name:'Resource fixture',reasoning:false,input:['text'],
   cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:1024}],
  streamSimple(model){
   const stream=createAssistantMessageEventStream();
   const tool=calls++===0;
   const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),
    content:tool?[{type:'toolCall',id:'budget-call',name:'budget_probe',arguments:{}}]:[{type:'text',text:'done'}],
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'pending'};
   queueMicrotask(()=>{
    stream.push({type:'start',partial:message});
    if(tool){stream.push({type:'toolcall_start',contentIndex:0,partial:message});
     stream.push({type:'toolcall_end',contentIndex:0,toolCall:message.content[0],partial:message});}
    message.stopReason=tool?'toolUse':'stop';
    stream.push({type:'done',reason:message.stopReason,message});stream.end();
   });return stream;
  }});
 ${realContext ? '' : `pi.registerTool({name:'ctx_execute',label:'fixture',description:'fixture',parameters:{type:'object',properties:{}},
  async execute(id,input){return {content:[{type:'text',text:JSON.stringify(input)}],details:{}};}});`}
 pi.registerTool({name:'budget_probe',label:'budget probe',description:'verify resource budget',parameters:{type:'object',properties:{}},
  async execute(id,input,signal,onUpdate,ctx){
   const a=await ctx.executeTool('ctx_execute',{language:'shell',code:'printf budget-ready'});
   const b=await ctx.executeTool('ctx_execute',{language:'shell',code:':',background:true});
   return {content:[{type:'text',text:JSON.stringify({a,b,inputs})}],details:{}};
  }});
}`);
const pi = execFileSync('/usr/bin/which', ['pi'], { encoding: 'utf8' }).trim();
const flags = ['--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-session', '--no-approve', '-e', resolve('pi/.pi/agent/extensions/resource-budget.ts'), '-e', probe,
 ...(realContext ? ['-e', join(homedir(), '.pi/agent/npm/node_modules/context-mode/build/adapters/pi/extension.js')] : []),
 '--provider', 'resource-fixture', '--model', 'resource-fixture', '--thinking', 'off', '--mode', 'rpc'];
// This bounded test host owns its single bridge, even when a ctx executor launches the test.
const child = spawn(pi, flags, { cwd: process.cwd(), env: { ...process.env, PI_OFFLINE: '1', CONTEXT_MODE_BRIDGE_DEPTH: '0' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
let output = '', errors = '', buffer = '';
const messages=[];
child.stdout.on('data', c => {
 buffer+=c;
 let newline;
 while((newline=buffer.indexOf('\n'))>=0){
  const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
  if(!line.trim())continue;
  const record=JSON.parse(line);
  if(['response','extension_error','agent_settled'].includes(record.type) || record.type==='message_end' && record.message?.role==='toolResult'){
   messages.push(record);output+=line+'\n';
  }
 }
});
child.stderr.on('data', c => { errors = (errors + c).slice(-10_000); });
const bound = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 60_000);
try {
 child.stdin.write(JSON.stringify({ id: 'ready', type: 'get_state' }) + '\n');
 const startup = Date.now() + 20_000;
 while (!output.includes('"id":"ready"') && Date.now() < startup && child.exitCode === null) await delay(100);
 assert.ok(output.includes('"id":"ready"'), errors);
 child.stdin.write(JSON.stringify({ id: 'probe', type: 'prompt', message: 'Run the resource budget fixture.' }) + '\n');
 const deadline = Date.now() + (realContext ? 35_000 : 10_000);
 while ((!output.includes('"type":"agent_settled"') || !output.includes('shutdown step')) && Date.now() < deadline && child.exitCode === null) await delay(100);
 const result=messages.find(record=>record.type==='message_end' && record.message?.role==='toolResult' && record.message.toolName==='budget_probe')?.message;
 assert.ok(result && !result.isError, `budget probe failed: ${output.slice(-2500)} ${errors}`);
 const outcomes=JSON.parse(result.content.find(part=>part.type==='text').text);
 assert.equal(outcomes.a.isError, false, `${JSON.stringify(outcomes.a)} ${errors}`);
 assert.equal(outcomes.inputs[0]?.timeout, 120000, 'default deadline missing');
 assert.equal(outcomes.b.isError, true, 'background work was not blocked');
 assert.ok(JSON.stringify(outcomes.b.result.content).includes('explicit timeout and a shutdown step'), 'background block reason missing');
 assert.ok(!output.includes('"type":"extension_error"'), output.slice(-2500));
 assert.ok(!errors.includes('Extension error'), errors);
 if (realContext) assert.ok(JSON.stringify(outcomes.a.result.content).includes('budget-ready'), `real execution failed: ${JSON.stringify(outcomes.a)} ${errors}`);
 console.log(`PASS real Pi nested tool${realContext ? ' and installed context-mode' : ''} uses 120000ms default and blocks unbounded background execution`);
} finally {
 const exited=()=>child.exitCode !== null || child.signalCode !== null;
 child.stdin.end();
 const shutdown=Date.now()+7000;
 while(!exited() && Date.now()<shutdown) await delay(50);
 if(!exited()){try{process.kill(-child.pid,'SIGTERM');}catch{}}
 const escalation=Date.now()+1000;
 while(!exited() && Date.now()<escalation) await delay(50);
 if(!exited()){try{process.kill(-child.pid,'SIGKILL');}catch{}}
 await delay(100);
 clearTimeout(bound);
 rmSync(dir, { recursive: true, force: true });
}
