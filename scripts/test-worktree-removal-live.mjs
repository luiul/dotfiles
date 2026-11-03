#!/usr/bin/env node
// Real Pi TUI fixture with the candidate extension set. No remote model calls.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const root=realpathSync(mkdtempSync(join(tmpdir(),'worktree-removal-live-')));
const name=`ag-guard-removal-${process.pid}`;
const cli=join(homedir(),'.pi/agent/install/current/node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const events=join(root,'events.jsonl');
const config=join(root,'agent');mkdirSync(join(config,'extensions'),{recursive:true});
const q=s=>`'${String(s).replaceAll("'","'\\''")}'`;
const tmux=(...args)=>execFileSync('tmux',args,{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
const log=()=>existsSync(events)?readFileSync(events,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pid;
try {
 const sourceExtensions=process.env.WORKTREE_REMOVAL_EXTENSIONS??join(repo,'pi/.pi/agent/extensions');
 for(const file of readdirSync(sourceExtensions)){
  const source=join(sourceExtensions,file);
  if((lstatSync(source).isFile()||lstatSync(source).isSymbolicLink())&&/\.(ts|js)$/.test(file))symlinkSync(source,join(config,'extensions',file));
 }
 // A isolated fresh TUI loads the candidate extensions without user packages.
 writeFileSync(join(config,'settings.json'),JSON.stringify({quietStartup:true,packages:[],compaction:{enabled:false},retry:{enabled:false}}));
 const cmd=`env PI_CODING_AGENT_DIR=${q(config)} PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 PI_OFFLINE=1 WORKTREE_REMOVAL_EVENTS=${q(events)} ${q(process.execPath)} ${q(cli)} --offline --no-skills --no-prompt-templates --no-context-files --no-approve --no-mcp --no-themes --session-dir ${q(join(root,'sessions'))} -e ${q(join(repo,'scripts/fixtures/worktree-removal-live.ts'))}`;
 tmux('new-session','-d','-s',name,'-x','120','-y','35',`cd ${q(repo)} && ${cmd}`);
 const watchdog=join(homedir(),'dotfiles/macos/.local/bin/reap-strays.mjs');
 const registration=spawnSync(process.execPath,[watchdog,'--register-tmux',name,'--owner',String(process.pid),'--deadline',String(Math.floor(Date.now()/1000)+100)],{timeout:10000,encoding:'utf8'});
 if(registration.status!==0)console.log('Watchdog registration unavailable; fixture keeps its 70-second deadline and explicit shutdown.');
 const until=Date.now()+70000;
 while(!log().some(e=>e.event==='start')){if(Date.now()>until)throw Error('Pi startup timed out');await sleep(200);}
 const initial=log().find(e=>e.event==='start');pid=initial.pid;
 assert(!initial.commands.includes('work-status'));
 tmux('send-keys','-t',name,'-l','/removal-check');tmux('send-keys','-t',name,'Enter');
 while(!log().some(e=>e.event==='checked')){if(Date.now()>until)throw Error('Pi command timed out');await sleep(200);}
 const screen=tmux('capture-pane','-p','-t',name);
 assert(screen.includes('GUARD_REMOVAL_VERIFIED'),screen);
 assert(!/Work pending|Work status unavailable|\/work-status|Failed to load extension|Extension error/.test(screen),screen);
 tmux('send-keys','-t',name,'C-u','C-d');
 while(!log().some(e=>e.event==='shutdown')){if(Date.now()>until)throw Error('Pi shutdown timed out');await sleep(200);}
 console.log('PASS: real Pi loads candidate extensions without completion command or widget');
 console.log('PASS: fresh interactive session starts, accepts a command, and shuts down');
} finally {
 spawnSync('tmux',['kill-session','-t',name],{timeout:10000,stdio:'ignore'});
 if(pid){try{process.kill(pid,0);process.kill(pid,'SIGTERM')}catch{}}
 rmSync(root,{recursive:true,force:true});
}
