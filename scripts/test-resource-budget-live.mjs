#!/usr/bin/env node
// Use a real Pi RPC session and public nested-tool API. No model call.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const dir = mkdtempSync(join(tmpdir(), 'resource-budget-live-'));
const probe = join(dir, 'probe.ts');
writeFileSync(probe, `export default function(pi) {
 pi.registerTool({name:'ctx_execute',label:'fixture',description:'fixture',parameters:{type:'object',properties:{}},
  async execute(id,input){return {content:[{type:'text',text:JSON.stringify(input)}],details:{}};}});
 pi.registerCommand('budget-probe',{description:'verify resource budget',handler:async(args,ctx)=>{
  const a=await ctx.executeTool('ctx_execute',{});
  const b=await ctx.executeTool('ctx_execute',{background:true});
  pi.sendMessage({customType:'budget-probe',content:JSON.stringify({a:a.content,b:b.content}),display:true});
 }});
}`);
const pi = execFileSync('/usr/bin/which', ['pi'], { encoding: 'utf8' }).trim();
const flags = ['--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-session', '--no-approve', '-e', resolve('pi/.pi/agent/extensions/resource-budget.ts'), '-e', probe, '--mode', 'rpc'];
const child = spawn(pi, flags, { cwd: process.cwd(), env: { ...process.env, PI_OFFLINE: '1' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
let output = '', errors = '';
child.stdout.on('data', c => { output = (output + c).slice(-100_000); });
child.stderr.on('data', c => { errors = (errors + c).slice(-10_000); });
const bound = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 30_000);
try {
 child.stdin.write(JSON.stringify({ id: 'ready', type: 'get_state' }) + '\n');
 const startup = Date.now() + 20_000;
 while (!output.includes('"id":"ready"') && Date.now() < startup && child.exitCode === null) await delay(100);
 assert.ok(output.includes('"id":"ready"'), errors);
 child.stdin.write(JSON.stringify({ id: 'probe', type: 'prompt', message: '/budget-probe' }) + '\n');
 const deadline = Date.now() + 10_000;
 while ((!output.includes('120000') || !output.includes('shutdown step')) && Date.now() < deadline && child.exitCode === null) await delay(100);
 assert.ok(output.includes('120000'), `default deadline missing: ${output.slice(-2500)} ${errors}`);
 assert.ok(output.includes('explicit timeout and a shutdown step'), 'background work was not blocked');
 assert.ok(!errors.includes('Extension error'), errors);
 console.log('PASS real Pi nested tool uses 120000ms default and blocks unbounded background execution');
} finally {
 clearTimeout(bound);
 if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
 await delay(500);
 if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
 await delay(100);
 rmSync(dir, { recursive: true, force: true });
}
